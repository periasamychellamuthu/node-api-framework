function NavigationInfo(parent,parentId,refField,grandParentInfo){
    this.refField = refField;
    this.parentEntity = parent;
    this.parentEntityId=parentId;
    this.grandParentInfo=grandParentInfo;
    this.parentBean=null;

    this.getRefField = function(){
        return this.refField;
    }

    this.getParentEntity = function(){
        return this.parentEntity;
    }

    this.getParentEntityId = function(){
        this.parentEntityId;
    }

}

module.exports = NavigationInfo;