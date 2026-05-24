// Package kubeatlas embeds the frontend assets so the compiled binary is
// fully self-contained. The embed directive resolves relative to this file,
// which is why it lives at the repository root alongside public/ — go:embed
// cannot reference parent directories, so the server package cannot embed it
// directly.
package kubeatlas

import (
	"embed"
	"io/fs"
)

//go:embed all:public
var publicFS embed.FS

// PublicFS returns the embedded public/ tree rooted at "public", so callers
// see the same layout as serving from disk (index.html, js/, css/, ext/, ...).
func PublicFS() fs.FS {
	sub, err := fs.Sub(publicFS, "public")
	if err != nil {
		// Unreachable: the path is a compile-time constant matched by go:embed.
		panic(err)
	}

	return sub
}
