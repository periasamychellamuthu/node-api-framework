var APIRequest=require('./API/APIRequest');
function DefaultRouterHandler(){
    this.handleRequest = function(req,res){
        const apiRequest = new APIRequest(req,res);
        var handler = apiRequest.entity.getHandlerInstance();
        console.log("request handled",handler);
        handler.handleAPICall(apiRequest);
    }
}

module.exports = new DefaultRouterHandler();