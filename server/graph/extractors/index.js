const confirmationStatement = require('./confirmationStatement');
const accounts = require('./accounts');
const incorporation = require('./incorporation');

const byCategory = {
  'confirmation-statement': confirmationStatement,
  accounts,
  incorporation,
};

function getExtractor(category) {
  return byCategory[category] || null;
}

module.exports = { getExtractor };
