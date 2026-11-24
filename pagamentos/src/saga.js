const { pool } = require('./db');
const { publicar } = require('./kafka');
const { cobrar, estornar } = require('./banco');

const log = (ctx, texto) => console.log(`[pagamentos] ${texto} pedido=${ctx.pedidoId} req=${ctx.correlationId}`);
const erro = (ctx, texto) => console.error(`[pagamentos] ERRO ${texto} pedido=${ctx.pedidoId} req=${ctx.correlationId}`);

const ctxDe = (evento) => ({ pedidoId: evento.pedidoId, correlationId: evento.correlationId });

// Estorna um pagamento APROVADO e publica pagamento.estornado.
// Compensação não pode sumir: se o estorno falhar, fica gravado como ESTORNO_PENDENTE e é tentado de novo.
async function estornarPagamento(pag, ctx) {
  try {
    const resultado = await estornar({ codigo: pag.codigo_transacao, referencia: pag.pedido_id }, ctx);
    await pool.query(
      `UPDATE pagamentos SET status = 'ESTORNADO', motivo = 'pedido cancelado: valor devolvido', atualizado_em = now()
       WHERE pedido_id = $1`,
      [pag.pedido_id],
    );
    log(ctx, `estorno ${pag.codigo_transacao}: ${resultado}`);
    await publicar('pagamentos', 'pagamento.estornado', pag.pedido_id, {
      usuarioId: pag.usuario_id,
      clienteEmail: pag.cliente_email,
      valor: pag.valor,
      codigoTransacao: pag.codigo_transacao,
    }, ctx.correlationId);
  } catch (err) {
    await pool.query(
      `UPDATE pagamentos SET status = 'ESTORNO_PENDENTE', motivo = $2, atualizado_em = now() WHERE pedido_id = $1`,
      [pag.pedido_id, `estorno falhou: ${err.message}`],
    );
    erro(ctx, `estorno de ${pag.codigo_transacao} falhou (${err.message}): ESTORNO_PENDENTE, será tentado de novo`);
  }
}

// estoque.reservado -> cobra. Tudo que precisa vem no evento: valor, forma, cartão final, e-mail.
async function processar(evento) {
  const ctx = ctxDe(evento);
  const { usuarioId, clienteEmail, valorTotal, formaPagamento, cartaoFinal } = evento.dados;

  // 1. Idempotência: o mesmo evento não cobra duas vezes; pedido já cancelado também não é cobrado.
  const { rows } = await pool.query(
    `INSERT INTO pagamentos (pedido_id, usuario_id, valor, forma, cartao_final, status, cliente_email, correlation_id)
     VALUES ($1, $2, $3, $4, $5, 'PENDENTE', $6, $7)
     ON CONFLICT (pedido_id) DO NOTHING
     RETURNING *`,
    [evento.pedidoId, usuarioId, valorTotal, formaPagamento, cartaoFinal, clienteEmail, ctx.correlationId],
  );
  if (rows.length === 0) {
    log(ctx, 'estoque.reservado ignorado: já existe pagamento para este pedido (repetido ou cancelado antes)');
    return;
  }

  // 2. Timeout + retry + circuit breaker.
  const r = await cobrar({ valor: valorTotal, cartaoFinal, referencia: evento.pedidoId, forma: formaPagamento }, ctx);

  if (r.aprovado) {
    // Só vira APROVADO se ainda estiver PENDENTE. Se o cliente cancelou durante a cobrança,
    // o pagamento já está CANCELADO: o banco cobrou e a gente devolve.
    const { rows: atualizados } = await pool.query(
      `UPDATE pagamentos SET status = 'APROVADO', tentativas = $2, codigo_transacao = $3, atualizado_em = now()
       WHERE pedido_id = $1 AND status = 'PENDENTE' RETURNING *`,
      [evento.pedidoId, r.tentativas, r.codigo],
    );
    if (atualizados.length === 0) {
      log(ctx, `cobrança ${r.codigo} aprovada, mas o pedido foi cancelado durante a cobrança: estornando`);
      await pool.query('UPDATE pagamentos SET tentativas = $2, codigo_transacao = $3 WHERE pedido_id = $1', [evento.pedidoId, r.tentativas, r.codigo]);
      const { rows: [pag] } = await pool.query('SELECT * FROM pagamentos WHERE pedido_id = $1', [evento.pedidoId]);
      await estornarPagamento(pag, ctx);
      return;
    }
    log(ctx, `pagamento APROVADO (${r.codigo}, ${r.tentativas} tentativa(s))`);
    await publicar('pagamentos', 'pagamento.aprovado', evento.pedidoId, {
      usuarioId, clienteEmail, valor: valorTotal, codigoTransacao: r.codigo,
    }, ctx.correlationId);
    return;
  }

  // 3. Recusado (402) ou ERRO (banco fora, timeout, circuito aberto): os dois viram pagamento.recusado,
  //    com motivos diferentes. A saga compensa igual: o catálogo devolve o estoque, o pedido vira CANCELADO.
  const status = r.erro ? 'ERRO' : 'RECUSADO';
  const { rowCount } = await pool.query(
    `UPDATE pagamentos SET status = $2, tentativas = $3, motivo = $4, atualizado_em = now()
     WHERE pedido_id = $1 AND status = 'PENDENTE'`,
    [evento.pedidoId, status, r.tentativas, r.motivo],
  );

  // Desistiu por timeout: o banco pode ter cobrado e só não respondido. Desfaz por segurança, pela referência.
  if (r.erro && r.timeout) {
    log(ctx, 'desistiu sem saber se o banco cobrou (timeout): pedindo estorno da referência por segurança');
    try {
      log(ctx, `estorno de segurança: ${await estornar({ referencia: evento.pedidoId }, ctx)}`);
    } catch (err) {
      erro(ctx, `estorno de segurança falhou: ${err.message}`);
    }
  }

  if (rowCount === 0) {
    log(ctx, `pagamento ${status}, mas o pedido já foi cancelado: nada a publicar`);
    return;
  }
  log(ctx, `pagamento ${status}: ${r.motivo} (${r.tentativas} tentativa(s))`);
  await publicar('pagamentos', 'pagamento.recusado', evento.pedidoId, {
    usuarioId, clienteEmail, valor: valorTotal, motivo: r.motivo,
  }, ctx.correlationId);
}

// pedido.cancelado -> bloqueia a cobrança futura ou estorna o que já foi cobrado.
async function aoCancelar(evento) {
  const ctx = ctxDe(evento);
  const { usuarioId, clienteEmail, valorTotal, formaPagamento, cartaoFinal } = evento.dados;

  // Ainda não cobrei? Ocupa o pedido_id com CANCELADO: o estoque.reservado que chegar depois é ignorado.
  const { rows } = await pool.query(
    `INSERT INTO pagamentos (pedido_id, usuario_id, valor, forma, cartao_final, status, motivo, cliente_email, correlation_id)
     VALUES ($1, $2, $3, $4, $5, 'CANCELADO', 'pedido cancelado antes da cobrança', $6, $7)
     ON CONFLICT (pedido_id) DO NOTHING
     RETURNING id`,
    [evento.pedidoId, usuarioId, valorTotal ?? 0, formaPagamento, cartaoFinal, clienteEmail, ctx.correlationId],
  );
  if (rows.length > 0) {
    log(ctx, 'pedido cancelado antes da cobrança: pagamento CANCELADO, a cobrança futura será ignorada');
    return;
  }

  // A cobrança está em andamento (outra réplica)? Marca CANCELADO: quando o banco responder, quem cobrou estorna.
  const { rowCount } = await pool.query(
    `UPDATE pagamentos SET status = 'CANCELADO', motivo = 'pedido cancelado durante a cobrança', atualizado_em = now()
     WHERE pedido_id = $1 AND status = 'PENDENTE'`,
    [evento.pedidoId],
  );
  if (rowCount > 0) {
    log(ctx, 'pedido cancelado durante a cobrança: se o banco aprovar, o valor é estornado');
    return;
  }

  // Já existe: só estorna se foi APROVADO. RECUSADO, ERRO e ESTORNADO não têm nada a devolver.
  const { rows: [pag] } = await pool.query('SELECT * FROM pagamentos WHERE pedido_id = $1', [evento.pedidoId]);
  if (pag.status !== 'APROVADO') {
    log(ctx, `pedido.cancelado: pagamento está ${pag.status}, nada a estornar`);
    return;
  }
  await estornarPagamento(pag, ctx);
}

// Compensação que falha não pode sumir: de tempos em tempos, tenta de novo os ESTORNO_PENDENTE.
async function reprocessarEstornosPendentes() {
  const { rows } = await pool.query("SELECT * FROM pagamentos WHERE status = 'ESTORNO_PENDENTE' ORDER BY atualizado_em LIMIT 20");
  for (const pag of rows) {
    await estornarPagamento(pag, { pedidoId: pag.pedido_id, correlationId: pag.correlation_id });
  }
}

const handlers = {
  'estoque.reservado': processar,
  'pedido.cancelado': aoCancelar,
};

module.exports = { handlers, reprocessarEstornosPendentes, TOPICOS_ESCUTADOS: ['estoque', 'pedidos'] };
