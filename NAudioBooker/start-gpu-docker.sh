#!/bin/bash

docker compose -f docker-compose.node.yml --profile "*" build
docker compose -f docker-compose.node.yml --profile "*" up -d
