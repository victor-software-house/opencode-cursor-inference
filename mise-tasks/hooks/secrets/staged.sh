#!/usr/bin/env bash
#MISE description="Scan the staged diff for credentials"
gitleaks git --staged --redact --no-banner
