import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carrierFromTracking, carrierMismatch } from "./carrier.js";

describe("carrier from a tracking number", () => {
  it("names the carriers it is sure of", () => {
    assert.equal(carrierFromTracking("1Z999AA10123456784"), "ups");
    assert.equal(carrierFromTracking("9400 1000 0000 0000 0000 00"), "usps");
    assert.equal(carrierFromTracking("420902109400100000000000000000"), "usps");
    assert.equal(carrierFromTracking("EC123456789US"), "usps");
    assert.equal(carrierFromTracking("961234567890123456789012"), null);
    assert.equal(carrierFromTracking("9612345678901234567890"), "fedex");
    assert.equal(carrierFromTracking("123456789012"), "fedex");
    assert.equal(carrierFromTracking("JD014600006281230704"), "dhl");
    assert.equal(carrierFromTracking("1234567890"), "dhl");
  });

  it("says nothing about numbers it does not know", () => {
    assert.equal(carrierFromTracking("PKG-001"), null);
    assert.equal(carrierFromTracking("12345"), null);
    assert.equal(carrierFromTracking(""), null);
  });

  it("flags a package in the wrong carrier's bin, and nothing else", () => {
    assert.deepEqual(carrierMismatch("1Z999AA10123456784", "usps"), { expected: "ups" });
    assert.equal(carrierMismatch("1Z999AA10123456784", "ups"), null);
    assert.equal(carrierMismatch("1Z999AA10123456784", "other"), null);
    assert.equal(carrierMismatch("PKG-001", "usps"), null);
  });
});
