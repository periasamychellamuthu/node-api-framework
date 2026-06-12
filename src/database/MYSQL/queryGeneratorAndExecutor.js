function queryGeneratorandExecutor() {

    this.join = function (options) {
        options.query.join(options.table, options.joinCriteria);
        if (options.criteria) {
            this.setCriteria(options);
        }
    }

    this.setCriteria = function (options) {
        options.query.where(options.criteria);
    }

    this.addFromTableInQuery = function (options) {
        options.query.from(options.table);
    }

    this._applyTenantBounds = async function (query, APIRequest) {
        if (!APIRequest || !APIRequest.entity) return;
        const SequenceGenerator = require('../../../APIFramework/Database/SequenceGenerator');
        const tenantId = (APIRequest.context && APIRequest.context.request.$credentials) ? APIRequest.context.request.$credentials.tenantId : 'default_tenant';
        const tableName = APIRequest.entity.getTableName();

        await SequenceGenerator.ensureTenantRange(tenantId, `${tableName}.id`);

        const range = SequenceGenerator.getTenantRangeSync(tenantId, `${tableName}.id`);
        if (range) {
            query.where(`${tableName}.id >=`, range.min);
            query.where(`${tableName}.id <=`, range.max);
        }
    }

    this.queryGet = async function (query, APIRequest, cbk) {
        await this._applyTenantBounds(query, APIRequest);
        query.get((err, result) => {
            query.release();
            if (err) {
                console.error("[QueryGenerator] Database GET Exception:", err.message);
                return cbk(null);
            }
            cbk(result);
        });
    }

    this.queryInsert = function (query, params, APIRequest, cbk) {
        // Do not impose bounds on insert, it utilizes the generated ID directly
        return query.insert(params.table, params.data);
    }

    this.queryDelete = async function (query, params, APIRequest, cbk) {
        await this._applyTenantBounds(query, APIRequest);
        return query.delete(params.table);
    }

    this.queryUpdate = async function (query, params, APIRequest, cbk) {
        await this._applyTenantBounds(query, APIRequest);
        query.update(params.table, params.data, params.criteria, cbk);
    }
}

module.exports = new queryGeneratorandExecutor();