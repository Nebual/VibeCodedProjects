#!/bin/bash

# usda-branded should run after import-off, as branded overrides some OFF entries
pnpx tsx import-off.mjs
pnpx tsx import-usda-foundation.mjs
pnpx tsx import-usda-branded.mjs

