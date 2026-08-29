'use strict';

class Range {

    static UNBOUNDED = -1;

    constructor(startIndex, numberOfObjects) {
        if (typeof startIndex !== 'number' || startIndex < 0) {
            throw new Error('[Range] startIndex must be a non-negative integer');
        }
        if (typeof numberOfObjects !== 'number') {
            throw new Error('[Range] numberOfObjects must be a number (use Range.UNBOUNDED for no cap)');
        }
        this.startIndex      = startIndex;
        this.numberOfObjects = numberOfObjects;
        Object.freeze(this);
    }

    get isUnbounded() {
        return this.numberOfObjects === Range.UNBOUNDED;
    }

    static first(n) {
        return new Range(0, n);
    }

    static page(pageNumber, pageSize) {
        return new Range(pageNumber * pageSize, pageSize);
    }
}

module.exports = Range;
