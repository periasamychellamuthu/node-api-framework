function Field(json){
    this.name=json.name;
    this.relationMapping=json.relational_mapping;
    this.isIdentifier=json.is_identifier;
    this.refEntity = json.entity;
    this.allowedValues = json.fill_allowed_values?json.fill_allowed_values:false;
    this.foreignKeyMapping =(json.ForeignKey_mapping?json.ForeignKey_mapping:null);
    this.isCollection =(json.isCollection?json.isCollection:false);
    this.standaloneCRUD =(json.standaloneCRUD?json.standaloneCRUD:false);

    this.getRefEntity = function(){
        var Entity = require("./Entity");
        return Entity.getEntityByName(this.refEntity);
    }

    this.getRefEntityName = function(){
        return this.refEntity;
    }

    this.getTableName = function(){
        return this.relationMapping.split('.')[0];
    }

    this.getColumnName = function(){
        return this.relationMapping.split('.')[1];
    }

    this.isAllowedValuesField = function(){
        if(this.allowedValues != false){
            return true;
        }
        return false;
    }

}

module.exports = Field;
module.exports.getRefEntity = function(field){
    var Entity = require("./Entity");
    return Entity.getEntityByName(field.refEntity);
}

module.exports.getRelationshipField = function(entity,referringEntity){
    
}