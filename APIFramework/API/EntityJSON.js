var json={
    "user":{
        "name":"user",
        "path": "/users",
        "table_name":"Users",
        "handlers":require('../../src/Handler/userEntityHandler'),
        "fields":[
            {
                "name":"id",
                "relational_mapping":"Users.USERID",
                "is_identifier":true
            },
            {
                "name":"first_name",
                "relational_mapping":"Users.FIRST_NAME"
            },
            {
                "name":"last_name",
                "relational_mapping":"Users.LAST_NAME"
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
                "relational_mapping":"Users.PASSWORD"
            }
        ]
      }
}

exports.addEntityJSON = function(entityJSON){
    json = Object.assign(json,entityJSON);
} 

exports.getEntityJSON = function(){
    return json;
}
