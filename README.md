# Api Framework

## Table of Contents

- [Install](#install)
- [Introduction](#introduction)
- [Steps](#steps to implement framework in your code)
  - [Defining MYSQL config](#Defining MYSQL config)
  - [Defining entityJSON](#Defining entityJSON)
  - [Defining custom handler for entities](#Defining custom handler for entities)
  - [Handle API request](#Handling API request)

## Install

This is a [Node.js](https://nodejs.org/en/) module available through the
[npm registry](https://www.npmjs.com/).

Before installing, [download and install Node.js](https://nodejs.org/en/download/).

Installation is done using the
[`npm install` command](https://docs.npmjs.com/getting-started/installing-npm-packages-locally):

```sh
$ npm i api-framework-rest
```
## Introduction

This is a node.js framework build for easy entity creation and performing CRUD operation for that entity.As of now this framework only support MYSQL DB operations.It is written in JavaScript, does not require compiling, and is 100% MIT licensed.

## steps to implement framework in your code

Below shown example uses express-js framework.

## Defining MYSQL config

To establish the connection with MYSQL database.In app.js file update the configuration of mysql by using the below code:

```
var frameworkConstants = require('api-framework-rest/APIFramework/Constants/FrameworkConstants')

frameworkConstants.updateDBCofig({
  "host": "localhost",
  "port": "3306",
  "database": "sampledatabase",
  "user": "root",
  "password": ""
})

```
## Defining entityJSON

EntityJson is the json which represents entity.

sample entity json is :

```
const UserEntityHandler = require('../public/handler/userEntityHandler');

{
  "user":{
    "name":"user",
    "path": "/users",
    "table_name":"Users",
    "handlers":UserEntityHandler,
    "fields":[
        {
            "name":"id",
            "relational_mapping":"Users.USERID",
            "is_identifier":true
        },
        {
            "name":"name",
            "relational_mapping":"Users.NAME"
        },
        {
            "name":"user_name",
            "relational_mapping":"Users.USER_NAME"
        },
        {
            "name":"email_address",
            "relational_mapping":"Users.EMAIL_ADDRESS"
        },
        {
            "name":"phone_number",
            "relational_mapping":"Users.CONTACT_NUMBER"
        },
        {
            "name":"password",
            "relational_mapping":"Users.PASS_WORD"
        }
    ]
  }}
  
```

entity json must need be define before call the api.


## Defining custom handler for entities

Based on every entity behaviours, their entity handlers may vary.so, we can either create seperate handler for every entity or use the default hanlder inside the module.By default it framework takes default entity handler unless the handler is explicitly defined.

A custom handle file must extend default entity handler and created custom handler must define inside the entityJSON.

A simple example of custom handler file in userEntityHandler.js file :

```
const ApiUtils = require('api-framework-rest/APIFramework/Utils/APIUtils');
const DefaultEntityHandler = ApiUtils.getDefaultEntityHandler();

function UserEntityHandler() {
    DefaultEntityHandler.call(this);
};
UserEntityHandler.prototype = Object.create(DefaultEntityHandler.prototype);
UserEntityHandler.prototype.constructor = UserEntityHandler;
UserEntityHandler.prototype.getEntityName = function(){
    return this.entityName;
}

module.exports = UserEntityHandler;

```

## Handle API request

After define the entity jsons and their respective handler, we handle the Apirequest.To handle Api request pass the request to the callHandler, response will be automatically handled.

sample example of handling APIRequest:

```
const callHandler = require('api-framework-rest/APIFramework/Handler/callHanlder')

/* GET users listing. */
router.get('/', function(req, res, next) {
  callHandler.call(req,res,{
    name :"students"
  })
});

```