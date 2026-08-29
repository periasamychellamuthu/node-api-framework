'use strict';

// DataModel is superseded by DataAccess + Row + DataObject.
// This file is kept only as a safety shim in case any external caller still requires it.
// All internal framework code has been migrated to DataAccess.

const dataAccess = require('./DataAccess');
module.exports   = dataAccess;
