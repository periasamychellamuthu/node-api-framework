const APIConstants = require('./constants');
var Entity = require('./Entity');
const NavigationInfo = require('./NavigationInfo');
const APIContext = require('./APIContext');
const InputData = require('./InputData');

function APIRequest(request, response) {

  var URLIPareseResult = new EntityLocator(request.baseUrl + (request.url == "/" ? "" : request.url));

  this.operation = request.method;
  this.result = {};
  this.response = response;
  this.isSubRequest;
  this.convenienceOperationName;
  this.convenienceOperationParam;

  // Wire up standard Context + Input Parsing objects
  this.context = new APIContext(request);
  this.inputData = new InputData(request.body, request.query);

  this.dataObject;
  this.entityBeanObject;
  this.entity = URLIPareseResult.currentEntity;
  this.entityId = URLIPareseResult.currentEntityId;
  this.firstTokenInPath = URLIPareseResult.firstTokenInPath;
  this.navigationInfo = URLIPareseResult.navigationInfo;
}

function getURLTokens(url) {
  url = url.replace(APIConstants.API_PATH, "");
  url = url.replace(APIConstants.API_VERSION, "");
  var tokens = url.split('/'), result = [];
  tokens.forEach(element => {
    if (element != "") {
      result.push(element);
    }
  });
  return result;
}

function EntityLocator(path) {

  var tokenList = getURLTokens(path);
  this.currentEntity = null;
  this.currentEntityId = null;
  this.navigationInfo = null;
  this.currentField = null;
  this.firstTokenInPath = null;
  var token = null;
  this.firstTokenInPath = tokenList[0];
  this.currentEntity = Entity.getEntityByPath(this.firstTokenInPath);
  for (var i = 1; i < tokenList.length; i++) {
    token = tokenList[i];
    if (token.startsWith('_')) break;

    this.entityId = Number(token);
    if (isNaN(this.entityId)) {
      this.currentField = this.currentEntity.getFieldByName(token);
      this.navigationInfo = new NavigationInfo(this.currentEntity, this.currentEntityId, this.currentField, this.navigationInfo);
      this.currentEntity = this.currentField.getRefEntity();
      this.currentEntityId = null;
    } else {
      this.currentEntityId = this.entityId;
      this.currentEntity.setId(this.currentEntityId);
    }
  }
}

module.exports = APIRequest;