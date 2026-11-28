import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import add_subscription as a

# What `claude setup-token` writes to its terminal around the sign-in link, trimmed from real runs.
CLI_2_1_330 = ("\x1b[38;5;246m(c to copy)\x1b[39m\r\r\n\r\r\n\x1b]8;id=1ubqwxv;https://claude.ai/oauth/authorize?Iy5ZvNcPbx9YPBx"
               "\x07\x1b[38;5;246mhttps://claude.ai/oauth/authorize?Iy5ZvNcPbx9YPBx\x1b[39m\x1b]8;;\x07\r\r\n")
CLI_OLDER = ("Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n"
             "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz\r\n")


def link_from(output):
    r, w = os.pipe()
    os.write(w, output.encode())
    os.close(w)
    try:
        url, _ = a.read_until(r, a.URL, 2)
    finally:
        os.close(r)
    return url


class SignInLink(unittest.TestCase):
    def test_short_link_of_current_cli_is_found(self):
        self.assertEqual(link_from(CLI_2_1_330), "https://claude.ai/oauth/authorize?Iy5ZvNcPbx9YPBx")

    def test_full_link_of_older_cli_is_found(self):
        self.assertEqual(link_from(CLI_OLDER),
                         "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz")

    def test_no_link_in_output_gives_none(self):
        self.assertIsNone(link_from("Welcome to Claude Code\r\nOpening browser to sign in\r\n"))


if __name__ == "__main__":
    unittest.main()
