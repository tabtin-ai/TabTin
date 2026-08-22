from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
AUDIT_SCRIPT = ROOT / "scripts" / "shared" / "open_source_security_audit.py"


def _run_audit(repository: Path, *, stage: bool = True) -> subprocess.CompletedProcess[str]:
    subprocess.run(
        ["git", "init", "-q"],
        cwd=repository,
        check=True,
    )
    if stage:
        subprocess.run(
            ["git", "add", "."],
            cwd=repository,
            check=True,
        )
    return subprocess.run(
        [sys.executable, str(AUDIT_SCRIPT), "--root", str(repository)],
        text=True,
        capture_output=True,
        check=False,
    )


class OpenSourceSecurityAuditTests(unittest.TestCase):
    def test_audit_includes_untracked_candidate_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            endpoint = "https://api-test." + "tabtin" + ".com"
            (root / "local-config.txt").write_text(endpoint, encoding="utf-8")

            result = _run_audit(root, stage=False)

        self.assertEqual(result.returncode, 1)
        self.assertIn("company-endpoint", result.stdout)

    def test_audit_rejects_company_configuration_without_echoing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / ".env.production"
            company_endpoint = "https://api-test." + "tabtin" + ".com"
            template_code = "_".join(("SMS", "123456789"))
            fixture.write_text(
                f"API_URL={company_endpoint}\n"
                "SENTRY_DSN=https://public@example.ingest.sentry.io/123\n"
                f"SMS_TEMPLATE_CODE={template_code}\n",
                encoding="utf-8",
            )

            result = _run_audit(root)

        self.assertEqual(result.returncode, 1)
        self.assertIn("company-endpoint", result.stdout)
        self.assertIn("company-service-config", result.stdout)
        self.assertNotIn(template_code, result.stdout)
        self.assertNotIn(company_endpoint, result.stdout)

    def test_audit_rejects_private_keys_and_provider_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "credentials.txt"
            provider_key = "sk-" + "abcdefghijklmnopqrstuvwxyz123456"
            credential_url = "https://" + "buildacct:r4nd0msecret@" + "registry.internal.invalid/npm"
            fixture.write_text(
                f"OPENAI_API_KEY={provider_key}\n"
                f"REGISTRY_URL={credential_url}\n"
                "-----BEGIN PRIVATE KEY-----\n"
                "ZXhhbXBsZS10ZXN0LWtleS1tYXRlcmlhbA==\n"
                "-----END PRIVATE KEY-----\n",
                encoding="utf-8",
            )

            result = _run_audit(root)

        self.assertEqual(result.returncode, 1)
        self.assertIn("provider-credential", result.stdout)
        self.assertIn("credential-url", result.stdout)
        self.assertIn("private-key", result.stdout)
        self.assertNotIn(provider_key, result.stdout)

    def test_audit_accepts_empty_env_references_and_example_domains(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / ".env.example"
            fixture.write_text(
                "OPENAI_API_KEY=\n"
                "SMS_TEMPLATE_CODE=\n"
                "SENTRY_DSN=https://public@example.ingest.sentry.io/123\n"
                "API_URL=https://api.example.com\n"
                "COLLAB_URL=wss://collab.example.com\n",
                encoding="utf-8",
            )
            source = root / "settings.py"
            source.write_text(
                'SECRET_KEY = os.getenv("SECRET_KEY", "")\n'
                'SMS_SIGN_NAME = os.getenv("SMS_SIGN_NAME", "")\n'
                'EXAMPLE_REGISTRY = "https://user:pass@example.com/npm/"\n'
                'EXAMPLE_PROXY = "https://example-user:example-password@192.0.2.10/"\n',
                encoding="utf-8",
            )

            result = _run_audit(root)

        self.assertEqual(result.returncode, 0)
        self.assertIn("Open-source security audit passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
