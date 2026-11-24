const { ObjectId } = require('mongodb');
const { produtos, reservas } = require('./db');
const { publicar } = require('./kafka');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const log = (evento, texto) => console.log(`[catalogo] ${texto} pedido=${evento.pedidoId} req=${evento.correlationId}`);

// Devolve ao disponível o que já foi tirado (tudo ou nada: faltou um item, nada fica reservado).
async function devolver(itens) {
  for (const item of itens) {
    await produtos().updateOne(
      { _id: new ObjectId(item.produtoId) },
      { $inc: { 'estoque.disponivel': item.quantidade, 'estoque.reservado': -item.quantidade } },
    );
  }
}

// pedido.criado -> reserva tudo ou nada e publica estoque.reservado ou estoque.insuficiente.
async function reservar(evento) {
  const { pedidoId, correlationId, dados } = evento;
  const itens = (dados.itens || []).map((i) => ({ produtoId: i.produtoId, nome: i.nome, quantidade: i.quantidade }));

  // 1. Idempotência: reservas.pedidoId é único. O mesmo evento de novo não reserva de novo.
  try {
    await reservas().insertOne({ pedidoId, itens, status: 'processando', criadoEm: new Date() });
  } catch (err) {
    if (err.code === 11000) {
      log(evento, 'pedido.criado repetido: reserva já existe, ignorado');
      return;
    }
    throw err;
  }

  // 2. Tudo ou nada. $gte no filtro: o Mongo só tira se houver; dois pedidos ao mesmo tempo
  //    não deixam o estoque negativo. Reservado ≠ vendido: disponivel diminui, reservado aumenta.
  const reservados = [];
  let faltou = null;
  try {
    for (const item of itens) {
      const valido = OBJECT_ID.test(item.produtoId) && Number.isInteger(item.quantidade) && item.quantidade > 0;
      const r = valido
        ? await produtos().updateOne(
          { _id: new ObjectId(item.produtoId), ativo: true, 'estoque.disponivel': { $gte: item.quantidade } },
          { $inc: { 'estoque.disponivel': -item.quantidade, 'estoque.reservado': item.quantidade } },
        )
        : { modifiedCount: 0 };

      if (!r.modifiedCount) {
        faltou = item;
        break;
      }
      reservados.push(item);
    }
  } catch (err) {
    // Erro no meio (Mongo fora por instantes): desfaz o que tirou e apaga a reserva,
    // para que a nova tentativa do kafka.js comece do zero em vez de ver "já existe".
    await devolver(reservados).catch(() => {});
    await reservas().deleteOne({ pedidoId, status: 'processando' }).catch(() => {});
    throw err;
  }

  if (faltou) {
    await devolver(reservados); // faltou um: devolve os que já tirou
    const motivo = `estoque insuficiente: ${faltou.nome || faltou.produtoId} (pedido ${faltou.quantidade})`;
    await reservas().updateOne({ pedidoId }, { $set: { status: 'insuficiente', motivo } });
    log(evento, `reserva recusada: ${motivo}`);
    await publicar('estoque', 'estoque.insuficiente', pedidoId, {
      motivo,
      usuarioId: dados.usuarioId,
      clienteEmail: dados.clienteEmail,
    }, correlationId);
    return;
  }

  // 3. Deu tudo certo. O evento repassa o que o pagamento precisa para cobrar sem consultar ninguém.
  await reservas().updateOne({ pedidoId }, { $set: { status: 'reservada', reservadaEm: new Date() } });
  log(evento, `estoque reservado (${itens.length} itens)`);
  await publicar('estoque', 'estoque.reservado', pedidoId, {
    usuarioId: dados.usuarioId,
    clienteEmail: dados.clienteEmail,
    itens,
    valorTotal: dados.valorTotal,
    formaPagamento: dados.formaPagamento,
    cartaoFinal: dados.cartaoFinal,
  }, correlationId);
}

// Muda a reserva de um status para outro (filtro de estado) e, se mudou, aplica o efeito no estoque.
// É a idempotência das compensações: liberar duas vezes não devolve duas vezes.
async function mudarReserva(evento, de, para, efeito, descricao) {
  const reserva = await reservas().findOneAndUpdate(
    { pedidoId: evento.pedidoId, status: de },
    { $set: { status: para, [`${para}Em`]: new Date() } },
  );
  if (!reserva) {
    log(evento, `${evento.tipo}: nenhuma reserva ${de}, nada a fazer`);
    return;
  }
  for (const item of reserva.itens) {
    await produtos().updateOne({ _id: new ObjectId(item.produtoId) }, { $inc: efeito(item.quantidade) });
  }
  log(evento, descricao);
}

// pagamento.aprovado: reservado -> vendido. O disponivel já tinha diminuído na reserva; agora sai do reservado.
const confirmar = (e) => mudarReserva(e, 'reservada', 'confirmada',
  (q) => ({ 'estoque.reservado': -q }), 'reserva confirmada: produto vendido (saiu do reservado)');

// COMPENSAÇÃO (pagamento.recusado e pedido.cancelado): devolve ao disponível. A mesma função para os dois.
const liberar = (e) => mudarReserva(e, 'reservada', 'liberada',
  (q) => ({ 'estoque.disponivel': q, 'estoque.reservado': -q }), `COMPENSAÇÃO (${e.tipo}): estoque devolvido ao disponível`);

// COMPENSAÇÃO (pagamento.estornado): o pedido chegou a ser confirmado (pago) e depois foi estornado,
// porque o cancelamento cruzou com a aprovação. Devolve o que já tinha saído como vendido.
const devolverVendido = (e) => mudarReserva(e, 'confirmada', 'devolvida',
  (q) => ({ 'estoque.disponivel': q }), 'COMPENSAÇÃO (pagamento.estornado): estoque vendido devolvido ao disponível');

// Cada serviço conhece só a própria compensação: o catálogo não sabe por que o pedido falhou,
// ele escuta e devolve o estoque.
const handlers = {
  'pedido.criado': reservar,
  'pagamento.aprovado': confirmar,
  'pagamento.recusado': liberar,
  'pedido.cancelado': liberar,
  'pagamento.estornado': devolverVendido,
};

module.exports = { handlers, TOPICOS_ESCUTADOS: ['pedidos', 'pagamentos'] };
