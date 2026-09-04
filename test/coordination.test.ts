import { describe, expect, it, vi } from "vitest";
import type { CommunicationAdapter as CommunicationAdapterType } from "../src/common/communication.js";
import { CommunicationAdapter } from "../src/common/communication.js";
import { CoordinationSession, handoffTargets, meetingTargets, oddRowTargets } from "../src/common/coordination.js";
import type { DeliverooClientAdapter } from "../src/common/deliveroo-client-adapter.js";
import type { Logger } from "../src/common/logger.js";
import type { TeamMessage } from "../src/common/types.js";
import { WorldModel } from "../src/common/world-model.js";

describe("Level 3 coordination", () => {
  it("completes the neighborhood meeting through two mocked client endpoints", async () => {
    const endpoints = mockTeam();
    const leader = new CoordinationSession();
    const follower = new CoordinationSession();
    leader.start("mission-1", "meet_near", { x: 2, y: 1 });

    await endpoints.leader.send(leader.request({ x: 1, y: 1 }));
    expect(follower.receive(endpoints.follower.drain()[0]!)).toBe(true);
    expect(follower.mission?.role).toBe("follower");

    await endpoints.follower.send(follower.ready({ x: 1, y: 1 })!);
    leader.receive(endpoints.leader.drain()[0]!);
    expect(leader.mission?.teammateReady).toBe(true);

    leader.ready({ x: 2, y: 1 });
    await endpoints.leader.send(leader.complete());
    follower.receive(endpoints.follower.drain()[0]!);
    expect(follower.mission?.phase).toBe("completed");
  });

  it("acknowledges a parcel handoff before the receiving agent completes it", async () => {
    const endpoints = mockTeam();
    const leader = new CoordinationSession();
    const follower = new CoordinationSession();
    leader.start("mission-handoff", "handoff", { x: 2, y: 0 });
    await endpoints.leader.send(
      leader.request({ x: 1, y: 0 }, { dropTarget: { x: 2, y: 0 }, escapeTarget: { x: 3, y: 0 } })
    );
    follower.receive(endpoints.follower.drain()[0]!);

    await endpoints.follower.send(follower.ready({ x: 1, y: 0 })!);
    leader.receive(endpoints.leader.drain()[0]!);
    await endpoints.leader.send(leader.message("handoff_available", { target: { x: 2, y: 0 } }));
    follower.receive(endpoints.follower.drain()[0]!);
    expect(follower.mission?.phase).toBe("handoff_available");
    expect(follower.mission?.target).toEqual({ x: 2, y: 0 });

    await endpoints.follower.send(follower.message("handoff_received"));
    leader.receive(endpoints.leader.drain()[0]!);
    expect(leader.mission?.phase).toBe("handoff_received");
    await endpoints.follower.send(follower.complete());
    leader.receive(endpoints.leader.drain()[0]!);
    expect(leader.mission?.phase).toBe("completed");
  });

  it("keeps the odd-row mission waiting until the green-light completion message", async () => {
    const endpoints = mockTeam();
    const leader = new CoordinationSession();
    const follower = new CoordinationSession();
    leader.start("mission-red-light", "odd_row_wait", { x: 3, y: 1 });
    await endpoints.leader.send(leader.request({ x: 1, y: 1 }));
    follower.receive(endpoints.follower.drain()[0]!);

    await endpoints.follower.send(follower.ready({ x: 1, y: 1 })!);
    leader.receive(endpoints.leader.drain()[0]!);
    leader.ready({ x: 3, y: 1 });
    expect(leader.mission?.phase).toBe("waiting");
    expect(leader.expired(Date.now() + 60_000)).toBe(false);

    await endpoints.leader.send(leader.complete());
    follower.receive(endpoints.follower.drain()[0]!);
    expect(follower.mission?.phase).toBe("completed");
  });

  it("times out a mission that never receives an acknowledgement", () => {
    const session = new CoordinationSession(100);
    session.start("mission-2", "meet_near", { x: 1, y: 0 }, {}, 1_000);

    expect(session.expired(1_100)).toBe(false);
    expect(session.expired(1_101)).toBe(true);
    expect(session.cancel("timeout").type).toBe("mission_cancel");
  });

  it("retains the reason supplied by a teammate cancellation", () => {
    const session = new CoordinationSession();
    session.start("mission-cancel", "meet_near", { x: 1, y: 0 });

    session.receive({
      from: "agent-a",
      type: "mission_cancel",
      payload: { missionId: "mission-cancel", reason: "target became unreachable" },
      timestamp: 1_000
    });

    expect(session.mission?.phase).toBe("cancelled");
    expect(session.mission?.payload.reason).toBe("target became unreachable");
  });

  it("assigns distinct reachable meeting and odd-row targets", () => {
    const world = corridorWorld();
    const meeting = meetingTargets(world, { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }, 2);
    const odd = oddRowTargets(world, { x: 0, y: 0 }, { x: 4, y: 0 });

    expect(meeting).not.toBeNull();
    expect(meeting?.leader).not.toEqual(meeting?.follower);
    expect(odd).not.toBeNull();
    expect(odd!.leader.y % 2).not.toBe(0);
    expect(odd!.follower.y % 2).not.toBe(0);
    expect(odd!.leader).not.toEqual(odd!.follower);
  });

  it("keeps handoff targets off delivery tiles", () => {
    const world = corridorWorld();
    world.observeMap(5, 2, [
      { x: 0, y: 0, type: "2" },
      { x: 1, y: 0, type: "3" },
      { x: 2, y: 0, type: "3" },
      { x: 3, y: 0, type: "3" },
      { x: 4, y: 0, type: "3" }
    ]);

    const targets = handoffTargets(world, { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }, 4);

    expect(targets).not.toBeNull();
    expect(targets?.leader).not.toEqual({ x: 0, y: 0 });
    expect(targets?.follower).not.toEqual({ x: 0, y: 0 });
  });
});

/** Connects two CommunicationAdapters through the same in-memory team-message bus. */
function mockTeam(): { leader: CommunicationAdapterType; follower: CommunicationAdapterType } {
  let receiveLeader: ((message: { from?: string; message: string }) => void) | undefined;
  let receiveFollower: ((message: { from?: string; message: string }) => void) | undefined;
  const logger = { event: vi.fn() } as unknown as Logger;
  const client = (side: "leader" | "follower") =>
    ({
      onMessage: (handler: (message: { from?: string; message: string }) => void) => {
        if (side === "leader") receiveLeader = handler;
        else receiveFollower = handler;
      },
      sendTeamMessage: async (message: TeamMessage) => {
        const incoming = { from: side, message: `TEAMMSG ${JSON.stringify(message)}` };
        if (side === "leader") receiveFollower?.(incoming);
        else receiveLeader?.(incoming);
      }
    }) as unknown as DeliverooClientAdapter;

  return {
    leader: new CommunicationAdapter(client("leader"), logger, "leader"),
    follower: new CommunicationAdapter(client("follower"), logger, "follower")
  };
}

function corridorWorld(): WorldModel {
  const world = new WorldModel();
  const tiles = [];
  for (let x = 0; x < 5; x += 1) {
    tiles.push({ x, y: 0, type: "3" }, { x, y: 1, type: "3" });
  }
  world.observeMap(5, 2, tiles);
  return world;
}
