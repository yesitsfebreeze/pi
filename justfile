# shows this help
help:
    @just --list

# install dependencies (no lifecycle scripts)
install:
    npm install --ignore-scripts

# build all packages
build:
    npm run build

# build all packages without network access
build-offline:
    npm run build:offline

# lint, format, type-check
check:
    npm run check

# run tests (skips LLM-dependent tests without API keys)
test:
    ./test.sh

# run pi from source — forwards args to the CLI, no external plugins
run *args:
    ./pi-test.sh -ne -ns -np --no-themes -nc {{args}}

# run pi from source without API keys
run-no-env *args:
    ./pi-test.sh --no-env {{args}}

# wipe build output
clean:
    npm run clean