// What the repository is, across ecosystems. Each fixture is a small synthetic repository
// of one kind; each test names what the briefing must say about it and what it must not.
// A rule from one stack showing up in another's briefing is the failure these exist for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, withRepo, put, read, sectionOf } from './helpers.mjs';

async function seed(dir, git, files) {
  for (const [name, text] of Object.entries(files)) await put(dir, name, text);
  await git('add', '-A');
  await git('commit', '-qm', 'init');
}

async function briefingOf(files, args = ['--yes']) {
  let text = '';
  await withRepo(async ({ dir, git, bare, script }) => {
    await seed(dir, git, files);
    const res = await bare(args);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const check = await script('briefing');
    assert.equal(check.code, 0, `every path the stack section names must exist:\n${check.stdout}${check.stderr}`);
    text = await read(dir, AGENTS);
  });
  return text;
}

const json = (value) => JSON.stringify(value, null, 2);
const ALL_STACK_RULE_MARKERS = [/Expo Router/, /npx expo install/, /App Router/, /Pages Router/, /manage\.py/, /db\/migrate/, /go mod tidy/, /prisma migrate/, /\.\/gradlew/];
const noForeignRules = (text, allowed) => {
  for (const marker of ALL_STACK_RULE_MARKERS) {
    if (allowed.some((ok) => String(ok) === String(marker))) continue;
    assert.doesNotMatch(text, marker, `a rule from another stack leaked in: ${marker}`);
  }
};

test('an Expo app is named as one, with only the rules this repository confirms', async () => {
  const text = await briefingOf({
    'package.json': json({ name: 'mobile', main: 'expo-router/entry', dependencies: { expo: '~57.0.0', 'expo-router': '~6.0.0', 'react-native': '0.80.0' } }),
    'src/app/_layout.tsx': 'export default function L() { return null; }\n',
    'src/app/index.tsx': 'export default function H() { return null; }\n',
    'app.config.ts': 'export default {};\n',
    '.gitignore': 'node_modules/\n/ios\n/android\n',
  });
  assert.match(text, /\*\*What this is\.\*\* An Expo mobile app \(React Native, Expo Router\), from `package\.json`\./);
  const rules = sectionOf(text, 'Stack Rules');
  assert.match(rules, /Every file under `src\/app\/` is a route \(Expo Router\)/);
  // Plain, not backticked: ignored folders are not on disk, and a backticked path is a claim that one is.
  assert.match(rules, /ios\/ and android\/ are generated .* and ignored \(`\.gitignore`\)/);
  assert.match(rules, /npx expo install/);
  assert.match(rules, /EXPO_PUBLIC_/);
  noForeignRules(text, [/Expo Router/, /npx expo install/]);
});

test('an Expo app without generated native folders in .gitignore is not told they are generated', async () => {
  const text = await briefingOf({
    'package.json': json({ name: 'mobile', dependencies: { expo: '~57.0.0' } }),
    'App.tsx': 'export default function A() { return null; }\n',
  });
  assert.match(text, /An Expo mobile app/);
  assert.doesNotMatch(text, /are generated .* and ignored/);
  assert.doesNotMatch(text, /is a route/, 'no router, no route rule');
});

test('a Next.js app names its router from the folder that exists', async () => {
  const text = await briefingOf({
    'package.json': json({ name: 'web', scripts: { build: 'next build', lint: 'next lint' }, dependencies: { next: '15.0.0', react: '19.0.0' } }),
    'app/page.tsx': 'export default function P() { return null; }\n',
    'app/layout.tsx': 'export default function L() { return null; }\n',
    '.github/workflows/ci.yml': 'jobs:\n  check:\n    steps:\n      - run: npm run lint\n',
  });
  assert.match(text, /\*\*What this is\.\*\* A Next\.js web app, from `package\.json`\./);
  assert.match(sectionOf(text, 'Stack Rules'), /App Router: folders under `app\/` are routes/);
  assert.doesNotMatch(text, /Pages Router/);
  assert.match(sectionOf(text, 'Stack Rules'), /NEXT_PUBLIC_/);
  noForeignRules(text, [/App Router/]);
});

test('a Django service is named from requirements.txt, with its migrations rule', async () => {
  const text = await briefingOf({
    'requirements.txt': 'Django==5.1\ndjangorestframework>=3.15\n',
    'manage.py': 'import django\n',
    'orders/models.py': 'class Order: pass\n',
    'orders/migrations/0001_initial.py': '# generated\n',
    'orders/migrations/__init__.py': '',
  });
  assert.match(text, /\*\*What this is\.\*\* A Django web app \(Django REST framework\), from `requirements\.txt`\./);
  const rules = sectionOf(text, 'Stack Rules');
  assert.match(rules, /`manage\.py`/);
  assert.match(rules, /1 migrations folder/);
  assert.doesNotMatch(text, /npm run/);
  noForeignRules(text, [/manage\.py/]);
});

test('a Go module with no CI is named from go.mod, with its module path', async () => {
  const text = await briefingOf({
    'go.mod': 'module example.com/ledger\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.1.0\n',
    'go.sum': 'github.com/go-chi/chi/v5 v5.1.0 h1:x\n',
    'cmd/ledger/main.go': 'package main\nfunc main() {}\n',
    'internal/store/store.go': 'package store\n',
  });
  assert.match(text, /\*\*What this is\.\*\* A Go API service \(chi\), module example\.com\/ledger, from `go\.mod`\./);
  assert.match(sectionOf(text, 'Stack Rules'), /`go\.sum` is maintained by `go mod tidy`/);
  noForeignRules(text, [/go mod tidy/]);
});

test('a Rails app is named from the Gemfile, and its schema is generated', async () => {
  const text = await briefingOf({
    Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\ngem 'pg'\n",
    'config/routes.rb': 'Rails.application.routes.draw do\nend\n',
    'db/schema.rb': '# generated\n',
    'db/migrate/20260101000000_create_orders.rb': 'class CreateOrders; end\n',
  });
  assert.match(text, /\*\*What this is\.\*\* A Rails web app, from `Gemfile`\./);
  const rules = sectionOf(text, 'Stack Rules');
  assert.match(rules, /`db\/schema\.rb` is generated/);
  assert.match(rules, /`db\/migrate\/`/);
  noForeignRules(text, [/db\/migrate/]);
});

test('a pnpm monorepo names each package by its own manifest', async () => {
  const text = await briefingOf({
    'package.json': json({ name: 'platform', private: true, packageManager: 'pnpm@9.12.0' }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'services/*'\n",
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'apps/web/package.json': json({ name: 'web', dependencies: { next: '15.0.0' } }),
    'apps/web/app/page.tsx': 'export default function P() { return null; }\n',
    'services/api/package.json': json({ name: 'api', dependencies: { '@nestjs/core': '11.0.0' } }),
    'services/api/src/main.ts': 'bootstrap();\n',
  });
  const what = text.match(/\*\*What this is\.\*\*[^\n]*/)[0];
  assert.match(what, /A pnpm monorepo \(`pnpm-workspace\.yaml`\) of 2 packages: `apps\/web\/` is a Next\.js web app; `services\/api\/` is a NestJS API service\./);
  assert.match(sectionOf(text, 'Stack Rules'), /App Router: folders under `apps\/web\/app\/` are routes/);
});

test('a library with no framework is called a library, and gets no stack rules', async () => {
  const text = await briefingOf({
    'package.json': json({ name: 'tiny-lib', main: 'dist/index.js', exports: { '.': './dist/index.js' }, devDependencies: { typescript: '6.0.0' } }),
    'src/index.ts': 'export const x = 1;\n',
  });
  assert.match(text, /\*\*What this is\.\*\* A JavaScript library \(package\.json "exports"\), from `package\.json`\./);
  assert.doesNotMatch(text, /## Stack Rules/);
});

test('a repository with no manifest says so instead of naming a stack', async () => {
  const text = await briefingOf({
    'notes/plan.md': '# Plan\n',
    'scripts/run.sh': '#!/bin/sh\necho hi\n',
  });
  assert.match(text, /\*\*What this is\.\*\* No manifest NASO reads \(package\.json, pyproject\.toml, go\.mod, Cargo\.toml, Gemfile and others\), so no stack is named\./);
  assert.doesNotMatch(text, /## Stack Rules/);
});

test('setup shows the stack before anything is written', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seed(dir, git, { 'Cargo.toml': '[package]\nname = "cli"\n\n[dependencies]\nclap = "4"\n', 'src/main.rs': 'fn main() {}\n' });
    const res = await bare(['--dry-run']);
    assert.match(res.stdout, /Stack\s+A Rust command-line tool \(clap\)/);
  });
});

test('a malformed manifest is read as no framework, not a crash', async () => {
  const text = await briefingOf({ 'package.json': '{ "name": "broken", ', 'src/a.ts': 'export {};\n' });
  assert.match(text, /\*\*What this is\.\*\* A JavaScript project, from `package\.json`\./);
});
