// Mesmo kafka.js em todos os serviços: publica e lê sempre com o mesmo envelope.
// { id, tipo, pedidoId, ocorridoEm, correlationId, dados }
const crypto = require('node:crypto');
const { Kafka, Partitioners, logLevel } = require('kafkajs');

const SERVICO = process.env.SERVICO || require('../package.json').name;
const TOPICOS = ['pedidos', 'estoque', 'pagamentos'];
const PARTICOES = 3;

const kafka = new Kafka({
  clientId: SERVICO,
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  logLevel: logLevel.WARN,
  retry: { retries: 10, initialRetryTime: 500 },
});

const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
const admin = kafka.admin();
let consumer;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Conecta uma vez, quando o serviço sobe. Quem sobe primeiro cria os tópicos (3 partições cada).
async function conectar(tentativas = 30) {
  for (let i = 1; ; i++) {
    try {
      await admin.connect();
      await producer.connect();
      break;
    } catch (err) {
      if (i >= tentativas) throw err;
      console.log(`[${SERVICO}] Aguardando o Kafka (${i}/${tentativas})...`);
      await esperar(2000);
    }
  }

  const existentes = await admin.listTopics();
  const faltando = TOPICOS.filter((t) => !existentes.includes(t));
  if (faltando.length > 0) {
    try {
      await admin.createTopics({ topics: faltando.map((topic) => ({ topic, numPartitions: PARTICOES })) });
      console.log(`[${SERVICO}] Tópicos criados: ${faltando.join(', ')}`);
    } catch (err) {
      // Outro serviço criou ao mesmo tempo: tudo bem.
      if (err.type !== 'TOPIC_ALREADY_EXISTS') console.log(`[${SERVICO}] createTopics: ${err.message}`);
    }
  }
}

// Chave = id do pedido: todos os eventos do mesmo pedido caem na mesma partição, em ordem.
// value é texto: o Kafka não sabe o que é JSON.
async function publicar(topico, tipo, pedidoId, dados, correlationId) {
  const evento = {
    id: crypto.randomUUID(),
    tipo,
    pedidoId: String(pedidoId),
    ocorridoEm: new Date().toISOString(),
    correlationId: correlationId || crypto.randomUUID(),
    dados,
  };
  await producer.send({ topic: topico, messages: [{ key: evento.pedidoId, value: JSON.stringify(evento) }] });
  console.log(`[${SERVICO}] publicou ${tipo} topico=${topico} pedido=${evento.pedidoId} req=${evento.correlationId}`);
  return evento;
}

// groupId = nome do serviço: réplicas dividem as partições sozinhas.
// O kafkajs confirma o offset depois que o eachMessage termina: pelo menos uma vez.
// Por isso todo handler precisa ser idempotente.
async function consumir(topicos, handlers) {
  consumer = kafka.consumer({ groupId: SERVICO });
  await consumer.connect();
  await consumer.subscribe({ topics: topicos, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      let evento;
      try {
        evento = JSON.parse(message.value.toString());
      } catch {
        console.error(`[${SERVICO}] mensagem inválida no tópico ${topic}: ignorada`);
        return;
      }

      const tratar = handlers[evento.tipo];
      if (!tratar) return; // tipo que não me interessa

      console.log(`[${SERVICO}] recebeu ${evento.tipo} pedido=${evento.pedidoId} req=${evento.correlationId}`);

      // Falha passageira (banco fora por instantes): tenta de novo algumas vezes antes de desistir.
      // Desistiu: o offset avança e o evento não volta. Ver "Limitações conhecidas" (DLQ) no README.
      for (let tentativa = 1; ; tentativa++) {
        try {
          await tratar(evento);
          return;
        } catch (err) {
          if (tentativa >= 5) {
            console.error(`[${SERVICO}] ERRO ao tratar ${evento.tipo} pedido=${evento.pedidoId} req=${evento.correlationId}: ${err.message} (desistiu após ${tentativa} tentativas)`);
            return;
          }
          console.warn(`[${SERVICO}] falha ao tratar ${evento.tipo} pedido=${evento.pedidoId} req=${evento.correlationId}: ${err.message} (tentativa ${tentativa}/5)`);
          await esperar(500 * 2 ** (tentativa - 1));
        }
      }
    },
  });
}

// Para o /health: uma pergunta barata ao broker, com prazo.
async function kafkaOk() {
  try {
    await Promise.race([
      admin.describeCluster(),
      esperar(2000).then(() => { throw new Error('timeout'); }),
    ]);
    return true;
  } catch {
    return false;
  }
}

// Ao parar o container: sai do grupo na hora (sem isso, o Kafka espera ~30 s para repassar as partições).
async function desconectar() {
  await Promise.allSettled([consumer?.disconnect(), producer.disconnect(), admin.disconnect()]);
}

module.exports = { conectar, publicar, consumir, kafkaOk, desconectar };
