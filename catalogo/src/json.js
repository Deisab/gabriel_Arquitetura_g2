// Documento do Mongo -> JSON da API: _id (ObjectId) vira id (string).
function paraJson(documento) {
  const { _id, ...resto } = documento;
  return { id: _id.toString(), ...resto };
}

module.exports = { paraJson };
