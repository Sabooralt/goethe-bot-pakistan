import sys, json
from invisible_playwright import InvisiblePlaywright

job = json.loads(sys.argv[1])

with InvisiblePlaywright() as browser:
    page = browser.new_page()
    page.goto(job["url"])
    result = {"title": page.title()}

print(json.dumps(result))  # stdout = JSON only; send logs to stderr