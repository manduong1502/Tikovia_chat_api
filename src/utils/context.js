const { AsyncLocalStorage } = require('async_hooks');

const contextStore = new AsyncLocalStorage();

module.exports = {
  contextStore
};
