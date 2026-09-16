// Writes a plugin's CURRENT capability signature into a userData config's
// approved list.
//
// Adding or editing anything in a plugin manifest's `capabilities` block —
// the `why` strings included — changes its approval signature, and
// main/plugins/plugins.js skips activating a plugin whose signature does not match
// what the config approved. That is the right behaviour for a real user, who
// gets a prompt explaining what changed, but it means an automated run
// against a copied config silently tests a plugin that never loaded.
//
// This is for a THROWAWAY userData copy made by one of the test wrappers.
// Point it at a live profile and you have quietly granted a capability the
// user never saw a prompt for.
//
// Usage: node tests/ui/lib/preapprove-plugin.js <repoRoot> <userDataDir> <pluginId>
const fs = require('fs');
const path = require('path');

const [repoRoot, userDataDir, pluginId] = process.argv.slice(2);
if (!repoRoot || !userDataDir || !pluginId) {
  console.error('usage: preapprove-plugin.js <repoRoot> <userDataDir> <pluginId>');
  process.exit(2);
}

const { normalizeCapabilities, capabilitiesSignature } = require(path.join(repoRoot, 'main', 'plugins', 'capabilities.js'));

const manifestPath = path.join(repoRoot, 'plugins', pluginId, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`no manifest at ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const signature = capabilitiesSignature(normalizeCapabilities(manifest.capabilities));

const configPath = path.join(userDataDir, 'channels.json');
if (!fs.existsSync(configPath)) {
  console.error(`no channels.json at ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.plugins = config.plugins || {};
config.plugins.approvedCapabilities = config.plugins.approvedCapabilities || {};
config.plugins.approvedCapabilities[pluginId] = signature;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`Pre-approved ${pluginId}'s current capabilities in the throwaway config.`);
