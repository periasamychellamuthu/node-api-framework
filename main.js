
//Automatically create server through express module
var server = require('./src/server/https/main');

var router = require('./APIFramework/DefaultRouterHandler');

server.application.all('*',router.handleRequest); //TODO : Need to defined security filter before route.