# Rotating the cluster's redis password without a window

The password every relay uses to reach redis is one string in twelve places:
once in redis itself and once in each machine's configuration. Changing it
naively means changing redis and then racing to change eleven machines, and
every second of that race is a relay that cannot see the cluster.

There is no race, because redis lets one user hold several passwords at once.

## The order

1. **Add the new password beside the old one.**

       redis-cli -p PORT -a OLD --no-auth-warning ACL SETUSER default '>NEW'

   Both now work. Nothing is disconnected and nothing has to be restarted —
   existing connections are already authenticated and new ones may use either.
   Verify all three cases before going further: old works, new works, wrong
   fails. A rotation that starts without that check is one where the second
   step is the first time anybody finds out.

2. **Change each machine's configuration and restart it, one at a time.**

   The password is read at startup and held in memory, so editing a file
   changes nothing until the process restarts — which is the fact that makes
   step 1 necessary rather than merely tidy. A machine part-way through this
   is not a broken machine: whichever password it holds, redis accepts it.

3. **Remove the old password, once every machine holds the new one.**

       redis-cli -p PORT -a NEW --no-auth-warning ACL SETUSER default '<OLD'

   Check first. A machine still on the old password will keep working until
   its next reconnect and then fail quietly, which is the worst way to find
   out that one was missed.

## What each restart costs

Calls in progress on that relay end — media is held by the process being
restarted. Nothing else: the other ten relays are unaffected, and the control
node signs tokens without redis.

So this is done when the fleet is idle, and it is done one machine at a time so
that a mistake costs one relay rather than the fleet.

## Why CONFIG SET is not used

`CONFIG` is disabled in this deployment's redis, deliberately — along with
FLUSHALL, FLUSHDB, SHUTDOWN and KEYS. Re-enabling it to make a rotation easier
would be trading a standing protection for a one-off convenience. ACL does the
same job and is not disabled.

## Rolling back

Every file is copied to `.rotate-bak` before it is touched, and the old password
stays valid until step 3. Up to that point, undoing this is restoring the
backups and restarting; after it, the old password is gone and only the new one
works.
