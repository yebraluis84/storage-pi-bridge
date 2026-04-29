/**
 * Standalone unlock test — bypasses the WebSocket entirely.
 *
 * Run this from the Pi when you're physically near a lock to verify the
 * BLE protocol works end-to-end before hooking up the cloud.
 *
 * Usage:
 *   npm run test:unlock -- F3:25:19:08:73:38 6b481fdfcd6c7c215fa8a54f439f63a7 0001e4008a6cc77f1c4544236fd9a69ec2e18503
 *                            ^MAC                ^offlineKey                       ^offlineUnlockCmd
 */

import { unlockLock } from './ble';

async function main() {
  const [, , mac, offlineKey, offlineUnlockCmd] = process.argv;

  if (!mac || !offlineKey || !offlineUnlockCmd) {
    console.error('Usage: npm run test:unlock -- <MAC> <offlineKey> <offlineUnlockCmd>');
    console.error('Example:');
    console.error('  npm run test:unlock -- F3:25:19:08:73:38 6b481fdfcd6c7c215fa8a54f439f63a7 0001e4008a6cc77f1c4544236fd9a69ec2e18503');
    process.exit(1);
  }

  console.log(`\nAttempting to unlock ${mac}...`);
  const result = await unlockLock({ mac, offlineKey, offlineUnlockCmd });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(result.success ? '✅ UNLOCKED' : '❌ FAILED');
  console.log(`   ${result.message}`);
  console.log(`   ${result.duration}ms`);
  if (result.battery != null) console.log(`   Battery: ${result.battery}%`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(result.success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
