var mysql = require("mysql");
var sqlConstants = require('./constants');
var QueryBuilder = require("node-querybuilder");
const APIrequest = require("../../../APIFramework/API/APIRequest");

function MySQLConnect(){
    this.pool = null;
    var builderObject = new QueryBuilder({
        "host": sqlConstants.host,
        "user": sqlConstants.user,
        "password": sqlConstants.password,
        "database": sqlConstants.database,
        "pool_size": 50
    },'mysql', 'pool');

    // builderObject._exec((sql, cb) =>{
    //     debugger;
    //     console.log("query executed");
    // });

    //Init MySql Connection pool
    this.init = function(){
        builderObject = new QueryBuilder({
            "host": sqlConstants.host,
            "user": sqlConstants.user,
            "password": sqlConstants.password,
            "database": sqlConstants.database,
            "pool_size": 50
        },'mysql', 'pool');
        return new Promise((resolve, reject) => {
            if (this.pool) {
                console.log("connection resolved");
                return resolve(this.pool);
            }

            // Generate Dataspace physically if absent
            const tempConnection = mysql.createConnection({
                host: sqlConstants.host,
                user: sqlConstants.user,
                password: sqlConstants.password,
                port: sqlConstants.port
            });

            tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${sqlConstants.database}\``, (err) => {
                tempConnection.end();
                if (err) {
                    console.error("[MySQL] Failed to create or confirm Dataspace:", err.message);
                    return reject(err);
                }

                // Proceed with functional database pool binding
                this.pool = mysql.createPool({
                    host: sqlConstants.host,
                    user: sqlConstants.user,
                    password: sqlConstants.password,
                    database: sqlConstants.database,
                    port: sqlConstants.port
                });

                mysql.Promise = global.Promise;
                this.pool.getConnection((err, connection) => {
                    if (err) return reject(err);
                    console.log(`[MySQL] Connection Pool verified on Dataspace '${sqlConstants.database}'`);
                    connection.release();
                    resolve(this.pool);
                });
            });
        });
    }

    this.acquire = function(callback){
        this.pool.getConnection(function(err,connection){
            callback(err,connection);
        });
    }

    this.runBuilder = function(cbk,APIRequest){
        builderObject.get_connection(db => {
            if (!db) {
                console.error("[MySQLConnect] Connection acquisition failure");
                if(APIRequest && APIRequest.response) {
                    APIRequest.response.status(500).json({ error: "Service degraded: Database pool exhausted." });
                }
                return;
            }
            db.get = function(table, cb, conn){
                // The table parameter is optional, it could be the cb...
                if (typeof table === 'function' && typeof cb !== 'function') {
                    cb = table;
                    table = undefined;
                }
            
                var sql_Query = this._get(table);
                this.reset_query(sql_Query);
                const sql = {sql:sql_Query,nestTables: true};
            
                if (typeof cb !== "function") return new WrapperPromise(sql, this._exec.bind(this)).promisify();
                this._exec(sql, cb);
            }
            cbk(db,APIRequest);
        });
    }
}

module.exports = new MySQLConnect();