const nodemailer = require('nodemailer');

// Mailpit: um servidor de e-mail de mentira. Recebe tudo e mostra em localhost:8025. Nada sai para a internet.
const smtp = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mailpit',
  port: Number(process.env.SMTP_PORT) || 1025,
  secure: false,
});

const REMETENTE = process.env.EMAIL_REMETENTE || 'Loja G2 <nao-responda@loja.com>';

const reais = (valor) => Number(valor ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const curto = (id) => String(id).slice(0, 8);

// Cada evento que interessa vira um e-mail. O clienteEmail vem dentro do evento:
// as notificações não consultam o serviço de usuários.
const MODELOS = {
  'pedido.criado': (e) => ({
    assunto: `Recebemos o seu pedido ${curto(e.pedidoId)}`,
    texto: [
      'Olá! Recebemos o seu pedido e já estamos separando os produtos.',
      '',
      ...(e.dados.itens || []).map((i) => `- ${i.quantidade}x ${i.nome} (${reais(i.precoUnitario)})`),
      '',
      `Total: ${reais(e.dados.valorTotal)} · pagamento: ${e.dados.formaPagamento}`,
      'Você recebe outro e-mail quando o pagamento for confirmado.',
    ].join('\n'),
  }),
  'estoque.insuficiente': (e) => ({
    assunto: `Pedido ${curto(e.pedidoId)} cancelado: sem estoque`,
    texto: `Infelizmente não conseguimos reservar os produtos do seu pedido.\nMotivo: ${e.dados.motivo}\nNada foi cobrado.`,
  }),
  // "Pedido confirmado" só depois do pagamento aprovado: antes, só "recebemos".
  'pagamento.aprovado': (e) => ({
    assunto: `Pagamento aprovado: pedido ${curto(e.pedidoId)} confirmado`,
    texto: `O pagamento de ${reais(e.dados.valor)} foi aprovado (transação ${e.dados.codigoTransacao}).\nSeu pedido está confirmado.`,
  }),
  'pagamento.recusado': (e) => ({
    assunto: `Pagamento recusado: pedido ${curto(e.pedidoId)} cancelado`,
    texto: `Não conseguimos cobrar ${reais(e.dados.valor)}.\nMotivo: ${e.dados.motivo}\nO pedido foi cancelado e os produtos voltaram para o estoque. Você pode tentar de novo.`,
  }),
  'pagamento.estornado': (e) => ({
    assunto: `Estorno do pedido ${curto(e.pedidoId)}`,
    texto: `O valor de ${reais(e.dados.valor)} (transação ${e.dados.codigoTransacao}) foi estornado.\nDependendo do banco, pode levar alguns dias para aparecer no extrato.`,
  }),
  'pedido.cancelado': (e) => ({
    assunto: `Pedido ${curto(e.pedidoId)} cancelado a seu pedido`,
    texto: 'Seu pedido foi cancelado como você pediu. Se algo já tinha sido cobrado, você recebe outro e-mail com o estorno.',
  }),
};

async function enviar(evento) {
  const modelo = MODELOS[evento.tipo];
  const para = evento.dados?.clienteEmail;
  if (!modelo || !para) return;

  const { assunto, texto } = modelo(evento);
  await smtp.sendMail({ from: REMETENTE, to: para, subject: assunto, text: texto });
  // Sem o e-mail no log: log é lido por muita gente e guardado por muito tempo.
  console.log(`[notificacoes] e-mail enviado: "${assunto}" pedido=${evento.pedidoId} req=${evento.correlationId}`);
}

const handlers = Object.fromEntries(Object.keys(MODELOS).map((tipo) => [tipo, enviar]));

const smtpOk = () => smtp.verify().then(() => true, () => false);

module.exports = { handlers, smtpOk, TOPICOS_ESCUTADOS: ['pedidos', 'estoque', 'pagamentos'] };
