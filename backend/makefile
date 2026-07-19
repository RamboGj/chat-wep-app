.PHONY: migrate generate run-api test

migrate:
	go run ./cmd/terndotenv

generate:
	sqlc generate -f ./internal/store/pgstore/sqlc.yml

run-api:
	air --build.cmd "go build -o ./bin/api ./cmd/api" --build.bin "./bin/api"

test:
	go test ./...
