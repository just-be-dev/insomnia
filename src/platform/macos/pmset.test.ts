import { describe, expect, it } from "@effect/vitest";
import { parseBattery, parseSleepDisabled, parseSudoList } from "./pmset.ts";
import { sudoersRule } from "./privileges.ts";

const pmsetG = (sleepDisabledLine: string) =>
  [
    "System-wide power settings:",
    sleepDisabledLine,
    "Currently in use:",
    " standby              1",
    " Sleep On Power Button 1",
    " hibernatefile        /var/vm/sleepimage",
    " powernap             1",
    " networkoversleep     0",
    " disksleep            10",
    " sleep                1 (sleep prevented by powerd, Amphetamine)",
    " hibernatemode        3",
    " ttyskeepawake        1",
    " displaysleep         2",
    " tcpkeepalive         1",
    " lowpowermode         0",
    " womp                 0",
  ].join("\n");

describe("parseSleepDisabled", () => {
  it("reads SleepDisabled 1 and 0", () => {
    expect(parseSleepDisabled(pmsetG(" SleepDisabled\t\t1"))).toBe(true);
    expect(parseSleepDisabled(pmsetG(" SleepDisabled\t\t0"))).toBe(false);
  });

  it("treats a missing SleepDisabled line as normal sleep", () => {
    expect(parseSleepDisabled(pmsetG(""))).toBe(false);
  });

  it("isn't fooled by other settings containing 'sleep 1'", () => {
    expect(parseSleepDisabled(pmsetG(" displaysleep 1"))).toBe(false);
  });
});

describe("parseBattery", () => {
  it("reads a discharging laptop", () => {
    expect(
      parseBattery(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22085731)\t95%; discharging; 6:59 remaining present: true\n",
      ),
    ).toEqual({ percent: 95, onAC: false });
  });

  it("reads a laptop on AC, including 100%", () => {
    expect(
      parseBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=22085731)\t100%; charged; 0:00 remaining present: true\n",
      ),
    ).toEqual({ percent: 100, onAC: true });
    expect(
      parseBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t7%; charging; (no estimate) present: true\n",
      ),
    ).toEqual({ percent: 7, onAC: true });
  });

  it("returns null on a Mac without a battery", () => {
    expect(parseBattery("Now drawing from 'AC Power'\n")).toBeNull();
  });

  it("ignores UPS and accessory batteries", () => {
    expect(
      parseBattery("Now drawing from 'AC Power'\n -CP1500 (id=1)\t100%; charging present: true\n"),
    ).toBeNull();
  });
});

describe("sudoersRule", () => {
  it("allows exactly the two disablesleep commands", () => {
    const rule = sudoersRule("just-be");
    expect(rule).toContain(
      "just-be ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1",
    );
    expect(rule.split("\n").filter((line) => line.includes("NOPASSWD"))).toHaveLength(1);
  });

  it("refuses usernames that could inject sudoers syntax", () => {
    expect(() => sudoersRule("evil ALL=(ALL) NOPASSWD: ALL #")).toThrow();
    expect(() => sudoersRule("a,b")).toThrow();
    expect(() => sudoersRule("")).toThrow();
  });
});

describe("parseSudoList", () => {
  const listing = (...rules: Array<string>) =>
    [
      "Matching Defaults entries for just-be on host:",
      "    env_reset, lecture_file=/etc/sudo_lecture, !log_allowed",
      "",
      "User just-be may run the following commands on host:",
      ...rules.map((rule) => `    ${rule}`),
    ].join("\n");

  it("treats (ALL) ALL as needing a password", () => {
    expect(
      parseSudoList(listing("(ALL) ALL", "(root) NOPASSWD: /usr/local/sbin/momadmin.sh")),
    ).toBe(false);
  });

  it("accepts insomnia's rule", () => {
    expect(
      parseSudoList(
        listing(
          "(ALL) ALL",
          "(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1",
        ),
      ),
    ).toBe(true);
  });

  it("rejoins rules sudo wrapped at 80 columns (real output without a tty)", () => {
    const wrapped = [
      "User just-be may run the following commands on G3YQ4F3926:",
      "    (ALL) ALL",
      "    (root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a",
      "        disablesleep 1",
      "    (root) NOPASSWD: /usr/local/sbin/momadmin.sh",
      "",
    ].join("\n");
    expect(parseSudoList(wrapped)).toBe(true);
  });

  it("needs both on and off to be passwordless", () => {
    expect(parseSudoList(listing("(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1"))).toBe(false);
  });

  it("accepts a blanket NOPASSWD: ALL", () => {
    expect(parseSudoList(listing("(ALL) NOPASSWD: ALL"))).toBe(true);
  });
});
