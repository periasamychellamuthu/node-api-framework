var API_CONSTANT={
    API_PATH : '/api',
    API_VERSION : '/v1'
}

var DB_CONFIG={}
const apiOperations={
    getAPIConstants:function(){
        return API_CONSTANT;
    },
    getDBConfig:function(){
        return DB_CONFIG;
    },
    updateAPIConstants:function(config){
        API_CONSTANT = Object.assign(API_CONSTANT,config);
        return API_CONSTANT;
    },
    updateDBCofig:function(config){
        DB_CONFIG=Object.assign(DB_CONFIG,config);
        require('../MYSQL/MYSQLConnect').init();
        return DB_CONFIG;
    }
}

module.exports = apiOperations;