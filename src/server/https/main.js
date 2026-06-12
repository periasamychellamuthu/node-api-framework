/*
Create Express app
Defined listeners
Call Base routing handler
*/

var serverConstants = require('./constants');

var express = require('express');
var https = require('https');
var fs = require('fs');
var path = require('path');
var app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, authorization, x-tenant-id');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('cookie-parser')());

var certsDir = path.join(__dirname, '..', '..', '..', 'certs');
var options = {
    key: fs.readFileSync(path.join(certsDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certsDir, 'cert.pem'))
};

//returns https server
var server = https.createServer(options, app).listen(serverConstants.port);

//server listeners
server.on('error', function (e) {
    console.error(`problem with request: ${e.message}`);
});

server.on('listening', function () {
    var addr = server.address();
    var bind = typeof addr === 'string'
        ? 'pipe ' + addr
        : 'port ' + addr.port;
    console.log('Listening on ' + bind);
});

module.exports = { 'application': app, 'obj': server };