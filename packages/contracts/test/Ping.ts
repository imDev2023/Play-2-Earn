import { expect } from "chai";
import { ethers } from "hardhat";

describe("Ping (scaffold smoke test)", () => {
  it("returns pong", async () => {
    const Ping = await ethers.getContractFactory("Ping");
    const ping = await Ping.deploy();
    expect(await ping.ping()).to.equal("pong");
  });
});
