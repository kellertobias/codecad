import { test } from "node:test";
import assert from "node:assert/strict";
import { openAccounts } from "../src/accounts.js";
import { SoftPasskey } from "./support/passkey.js";

const rp = {
  id: "cad.example",
  origin: "https://cad.example",
  name: "CodeCAD",
};

test("an account is made with a passkey and signed into with it", () => {
  const accounts = openAccounts(":memory:");
  const passkey = new SoftPasskey(rp.origin, rp.id);
  const options = accounts.registrationOptions(rp, { name: "Ada" }) as {
    challenge: string;
  };
  const made = accounts.register(rp, passkey.create(options));
  assert.equal(made.user.name, "Ada");
  assert.deepEqual(accounts.session(made.session), made.user);

  const signIn = accounts.loginOptions(rp) as { challenge: string };
  const again = accounts.login(rp, passkey.get(signIn));
  assert.equal(again.user.id, made.user.id);
  assert.notEqual(again.session, made.session);

  accounts.logout(again.session);
  assert.equal(accounts.session(again.session), undefined);
  assert.equal(accounts.session("made up"), undefined);
  accounts.close();
});

test("passkeys that do not fit are refused", () => {
  const accounts = openAccounts(":memory:");
  const passkey = new SoftPasskey(rp.origin, rp.id);
  // Another site's origin.
  const options = accounts.registrationOptions(rp, { name: "Ada" }) as {
    challenge: string;
  };
  assert.throws(
    () =>
      accounts.register(
        rp,
        passkey.create(options, { origin: "https://evil.example" }),
      ),
    /another site/,
  );
  // A challenge is used once.
  const fresh = accounts.registrationOptions(rp, { name: "Ada" }) as {
    challenge: string;
  };
  const response = passkey.create(fresh);
  accounts.register(rp, response);
  assert.throws(() => accounts.register(rp, response), /expired/);
  // Names are unique, whatever their case.
  assert.throws(
    () => accounts.registrationOptions(rp, { name: "ada" }),
    /taken/,
  );
  // An unknown passkey, and a signature by the wrong key.
  const stranger = new SoftPasskey(rp.origin, rp.id);
  assert.throws(
    () => accounts.login(rp, stranger.get(accounts.loginOptions(rp) as never)),
    /not known/,
  );
  const forged = stranger.get(accounts.loginOptions(rp) as never);
  forged.id = passkey.get({ challenge: "x" }).id;
  assert.throws(() => accounts.login(rp, forged), /signature/);
  // A counter that goes backwards: a cloned authenticator.
  accounts.login(
    rp,
    passkey.get(accounts.loginOptions(rp) as never, { counter: 10 }),
  );
  assert.throws(
    () =>
      accounts.login(
        rp,
        passkey.get(accounts.loginOptions(rp) as never, { counter: 5 }),
      ),
    /counter/,
  );
  accounts.close();
});

test("a signed-in user adds a second passkey", () => {
  const accounts = openAccounts(":memory:");
  const phone = new SoftPasskey(rp.origin, rp.id);
  const laptop = new SoftPasskey(rp.origin, rp.id);
  const { user } = accounts.register(
    rp,
    phone.create(accounts.registrationOptions(rp, { name: "Grace" }) as never),
  );
  accounts.register(
    rp,
    laptop.create(accounts.registrationOptions(rp, { user }) as never),
  );
  const signed = accounts.login(
    rp,
    laptop.get(accounts.loginOptions(rp) as never),
  );
  assert.equal(signed.user.id, user.id);
  accounts.close();
});
