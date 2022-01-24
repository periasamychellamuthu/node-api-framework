var json={}

exports.addEntityJSON = function(entityJSON){
    json = Object.assign(json,entityJSON)
} 

exports.getEntityJSON = function(){
    return json
}
