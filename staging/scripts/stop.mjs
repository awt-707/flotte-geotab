import { spawnSync } from 'node:child_process';
import { assertLocalProject } from './guard.mjs';
import { CLI, STAGING_ROOT, localCliEnv } from './paths.mjs';

assertLocalProject();
const result = spawnSync(CLI, ['stop', '--workdir', STAGING_ROOT], { cwd: STAGING_ROOT, env: localCliEnv(), encoding: 'utf8' });
if (result.status !== 0) throw new Error('Arret du staging impossible : verifier Docker.');
console.log('Pile ludy-staging arretee, donnees locales conservees. Le serveur web se termine avec Ctrl+C.');
