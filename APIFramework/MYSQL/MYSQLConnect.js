var mysql = require("mysql");
var frameworkConstants = require('../Constants/FrameworkConstants');
var QueryBuilder = require("node-querybuilder");
const APIrequest = require("../Api/APIrequest");

function MySQLConnect(){
    this.pool = null;
    var mysqlConstant = frameworkConstants.getDBConfig();
    var builderObject = new QueryBuilder({
        "host": mysqlConstant.host,
        "user": mysqlConstant.user,
        "password": mysqlConstant.password,
        "database": mysqlConstant.database,
        "pool_size": 50
    },'mysql', 'pool');

    // builderObject._exec((sql, cb) =>{
    //     debugger;
    //     console.log("query executed");
    // });

    //Init MySql Connection pool
    this.init = function(){
        builderObject = new QueryBuilder({
            "host": mysqlConstant.host,
            "user": mysqlConstant.user,
            "password": mysqlConstant.password,
            "database": mysqlConstant.database,
            "pool_size": 50
        },'mysql', 'pool');
        return new Promise((resolve, reject) => {
            if (this.pool) {
                console.log("connection resolved");
                return resolve(this.pool);
            }
            this.pool = mysql.createPool({
                host: mysqlConstant.host,
                user: mysqlConstant.user,
                password: mysqlConstant.password,
                database: mysqlConstant.database
            });
            mysql.Promise = global.Promise;
            this.pool.getConnection(function(err,connection){
                console.log(err+'and pool is'+this.pool);
                connection.release();
               if (err) reject(err);
               resolve(this.pool);
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
            db.get = function(table, cb, conn){
                // The table parameter is optional, it could be the cb...
                if (typeof table === 'function' && typeof cb !== 'function') {
                    cb = table;
                }
            
                var sql_Query = this._get(table);
                this.reset_query(sql_Query);
                const sql = {sql:sql_Query,nestTables: true};
            
                if (typeof cb !== "function") return new WrapperPromise(sql, this._exec.bind(this)).promisify();
                this._exec(sql, cb);
            }
            cbk(db,APIrequest);
        });
    }
}

module.exports = new MySQLConnect();