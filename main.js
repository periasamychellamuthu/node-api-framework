
//Automatically create server through express module
var server = require('./src/server/https/main');

var router = require('./APIFramework/DefaultRouterHandler');

// Ignore the browser's favicon requests
server.application.get('/favicon.ico', (req, res) => res.status(204).end());

server.application.all('*', router.handleRequest); //TODO : Need to defined security filter before route.