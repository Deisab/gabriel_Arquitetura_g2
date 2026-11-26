const { pool } = require('./db');

// Filtro de estado: só muda se o pedido estiver num dos status esperados.
// Evento repetido ou atrasado não faz nada e não leva o pedido para trás
// (um CANCELADO não volta a PAGO porque o banco aprovou atrasado).
async function mudarStatus(evento, novo, de, motivo = null) {
  const { rowCount } = await pool.query(
    `UPDATE pedidos SET status = $2, motivo = COALESCE($4, motivo), atualizado_em = now()
     WHERE id = $1 AND status = ANY($3)`,
    [evento.pedidoId, novo, de, motivo],
  );

  const req = `pedido=${evento.pedidoId} req=${evento.correlationId}`;
  if (rowCount > 0) console.log(`[pedidos] status -> ${novo}${motivo ? ` (${motivo})` : ''} ${req}`);
  else console.log(`[pedidos] ${evento.tipo} ignorado: pedido não está em ${de.join(' ou ')} ${req}`);
}

// Reações aos eventos dos outros serviços (coreografia: ninguém manda no pedidos, ele escuta).
const handlers = {
  'estoque.reservado': (e) => mudarStatus(e, 'AGUARDANDO_PAGAMENTO', ['AGUARDANDO_ESTOQUE']),
  'estoque.insuficiente': (e) => mudarStatus(e, 'CANCELADO', ['AGUARDANDO_ESTOQUE'], e.dados?.motivo || 'estoque insuficiente'),
  // Entre tópicos não há ordem: sob carga, o pagamento.aprovado (tópico pagamentos) pode chegar ANTES do
  // estoque.reservado (tópico estoque) do mesmo pedido. Como só existe pagamento depois de a reserva dar certo,
  // PAGO também vale a partir de AGUARDANDO_ESTOQUE; o estoque.reservado atrasado encontra PAGO e é ignorado.
  'pagamento.aprovado': (e) => mudarStatus(e, 'PAGO', ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO']),
  // Compensação: pagamento recusado (ou banco fora) cancela o pedido, com o motivo.
  'pagamento.recusado': (e) => mudarStatus(e, 'CANCELADO', ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO'], e.dados?.motivo || 'pagamento recusado'),
};

module.exports = { handlers, TOPICOS_ESCUTADOS: ['estoque', 'pagamentos'] };
