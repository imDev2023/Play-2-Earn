import { expect } from "chai";
import { keccak256 } from "ethers";
import { buildHashChain } from "../scripts/lib/hashchain";

describe("buildHashChain", () => {
  it("links each node as the keccak256 pre-image of the previous", () => {
    const chain = buildHashChain("rushood-test-seed", 8);
    expect(chain).to.have.lengthOf(8);
    for (let k = 1; k < chain.length; k++) {
      expect(keccak256(chain[k])).to.equal(chain[k - 1]);
    }
  });

  it("is deterministic for a given seed and length", () => {
    expect(buildHashChain("seed-a", 5)).to.deep.equal(buildHashChain("seed-a", 5));
    expect(buildHashChain("seed-a", 5)[0]).to.not.equal(buildHashChain("seed-b", 5)[0]);
  });

  it("rejects a length below 2", () => {
    expect(() => buildHashChain("seed", 1)).to.throw("length must be >= 2");
  });
});
