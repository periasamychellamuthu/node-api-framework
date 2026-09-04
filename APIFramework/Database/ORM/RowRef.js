/**
 * RowRef — deferred PK placeholder for cross-row FK wiring inside a DataObject.
 *
 * Problem it solves:
 *   When building a parent→child row chain in a single DataObject, the parent's PK
 *   is not known yet (it will be AUTO_INCREMENT-generated on INSERT). The child needs
 *   to reference that PK as its FK value. RowRef captures "the PK of this parent row"
 *   as a lazy reference. DataAccess.add() back-fills the real PK onto the parent Row
 *   after INSERT; when it then calls toResolvedObject() on the child row, RowRef.resolve()
 *   reads the now-populated real value from the parent.
 *
 * Usage (in caller code):
 *   const parentRow = dataAccess.newRow('iam_auth_accounts');
 *   // do NOT set 'auth_account_id' — leave it unset so Row.get() returns a RowRef
 *   const ref = parentRow.get('auth_account_id');   // → RowRef instance
 *
 *   const childRow = dataAccess.newRow('iam_account_profiles');
 *   childRow.set('auth_account_id', ref);            // store the RowRef as FK value
 *
 *   // DataAccess.add(dobj):
 *   //   1. INSERT parent  → captures insertId → parent._current['auth_account_id'] = insertId
 *   //   2. childRow.toResolvedObject() → ref.resolve() → returns insertId
 *   //   3. INSERT child with real FK value
 *
 * Rules:
 *   - resolve() must only be called after the parent row has been inserted and
 *     its PK back-filled. Calling it earlier throws to surface dependency-order bugs.
 *   - RowRef is a value type — do not mutate it after construction.
 */
class RowRef {
    /**
     * @param {import('./Row')} parentRow   — the Row whose PK we are deferring
     * @param {string}          pkColumn    — the PK column name on parentRow
     */
    constructor(parentRow, pkColumn) {
        this._parentRow = parentRow;
        this._pkColumn  = pkColumn;

        // Freeze so callers cannot accidentally mutate the reference.
        Object.freeze(this);
    }

    /**
     * Resolve the deferred reference to its real value.
     *
     * Reads _current[pkColumn] directly from the parent row — bypasses the
     * Row.get() placeholder logic to avoid infinite recursion.
     *
     * @returns {*} the real PK value
     * @throws  {Error} if the parent has not yet been inserted (value still null/undefined)
     */
    resolve() {
        const value = this._parentRow._current[this._pkColumn];
        if (value === undefined || value === null) {
            throw new Error(
                `[RowRef] Cannot resolve PK "${this._pkColumn}" on table ` +
                `"${this._parentRow.tableName}" — parent row has not been inserted yet. ` +
                `Ensure parent and child rows are in the same DataObject so DataAccess.add() ` +
                `can back-fill the generated PK before resolving child FKs.`
            );
        }
        return value;
    }

    /**
     * Human-readable tag for debugging.
     */
    toString() {
        return `RowRef(${this._parentRow.tableName}.${this._pkColumn})`;
    }
}

module.exports = RowRef;
