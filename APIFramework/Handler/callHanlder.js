exports.call = function(request,response,entity){
    // const APIRequest = require('../api/APIrequest');
    // APIRequest.addNecessaryDetailsForRequest(request,response,entity);
    // var handler = APIRequest.entity.getHandlerInstance();
    // handler.handleAPICall(APIRequest);

    console.log(`Filename is ${__filename}`);
    console.log(`Directory name is ${__dirname}`);
    const APIRequest = require('../Api/APIrequest');
    const req = new APIRequest();
    req.addNecessaryDetailsForRequest(request,response,entity);
    var handler = req.entity.getHandlerInstance();
    handler.handleAPICall(req);
}