import assert from "node:assert/strict";
import { isAppBusy } from "./pose";

assert.equal(isAppBusy({}, {}, {}), false);
assert.equal(isAppBusy({ "model-a": true }, {}, {}), true);
assert.equal(isAppBusy({}, { "model-a": true }, {}), true);
assert.equal(isAppBusy({}, {}, { "model-a": true }), true);
