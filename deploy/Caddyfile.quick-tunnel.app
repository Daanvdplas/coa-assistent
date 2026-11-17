# Separate release-gated app profile. Never select this for maintenance checks.
# Only the local cloudflared origin may supply CF-Connecting-IP; verify the edge
# overwrites forged values before enabling this profile on the temporary URL.
{
	admin off
	auto_https off
	servers {
		protocols h1
	}
	log default {
		format filter {
			wrap json
			fields {
				request delete
			}
		}
	}
}

(coa_cloudflare_backend) {
	reverse_proxy 127.0.0.1:8766 {
		header_up X-Real-IP {http.request.header.CF-Connecting-IP}
	}
}

http://:9899 {
	bind 127.0.0.1
	header Content-Security-Policy "frame-ancestors 'none'"
	header X-Frame-Options DENY
	@read {
		method GET HEAD
		path / /demo /demo/ /techniek/ /resultaten/ /assets/* /api/source /api/session /api/evals/rag /api/evals/rag/catalog
	}
	@run {
		method GET HEAD
		path_regexp run ^/api/runs/r-[0-9]+-[0-9]+$
	}
	@write {
		method POST
		path /api/session /api/runs
	}
	route {
		handle @read {
			import coa_cloudflare_backend
		}
		handle @run {
			import coa_cloudflare_backend
		}
		handle @write {
			import coa_cloudflare_backend
		}
		respond "Niet gevonden." 404
	}
}
