package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"

	"github.com/joho/godotenv"
)

// terndotenv loads .env when present and then shells out to `tern migrate`, so
// tern.conf's {{env "CHATAPP_*"}} placeholders resolve without exporting
// anything. With no .env the vars are expected to come from the environment.
func main() {
	if err := godotenv.Load(); err != nil && !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "failed to load .env: %v\n", err)
		os.Exit(1)
	}

	cmd := exec.Command(
		"tern",
		"migrate",
		"--migrations", "./internal/store/pgstore/migrations",
		"--config", "./internal/store/pgstore/migrations/tern.conf",
	)

	out, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Fprintf(os.Stderr, "tern migrate failed: %v\n%s\n", err, out)
		os.Exit(1)
	}

	fmt.Println("migrations applied")
	if len(out) > 0 {
		fmt.Print(string(out))
	}
}
