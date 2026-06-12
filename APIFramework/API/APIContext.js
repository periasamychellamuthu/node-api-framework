class APIContext {
    constructor(request) {
        this.request = request;
        this.transaction = null;
        this.user = request.user || null;
        this.locale = request.headers['accept-language'] || 'en-US';
        this.startTime = Date.now();
    }

    setTransaction(txn) {
        this.transaction = txn;
    }

    getTransaction() {
        return this.transaction;
    }

    getUser() {
        return this.user;
    }

    getLocale() {
        return this.locale;
    }

    getExecutionTime() {
        return Date.now() - this.startTime;
    }
}

module.exports = APIContext;
