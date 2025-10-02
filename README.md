\# Service Fusion – Customer Search (Apify Actor)



Logs into Service Fusion, opens the \*\*Customers\*\* page, runs \*\*Quick search\*\* with one or more addresses, and saves the results to the run's Dataset. Also stores a screenshot and page HTML.



\## Prerequisites

\- Apify account: https://console.apify.com

\- Service Fusion credentials: company ID, username, password



\## Deploy on Apify (from GitHub)

1\. Put these files in a GitHub repo.

2\. In Apify Console → \*\*Actors\*\* → \*\*Create new\*\* → \*\*From GitHub\*\* → pick your repo → \*\*Build\*\*.

3\. In Actor → \*\*Settings → Environment variables\*\* add:

&nbsp;  - `SERVICEFUSION\_COMPANY\_ID`

&nbsp;  - `SERVICEFUSION\_USERNAME`

&nbsp;  - `SERVICEFUSION\_PASSWORD`



\## Run

Example \*\*INPUT\*\*:

```json

{

&nbsp; "addresses": \["1462 22nd", "123 Main St"],

&nbsp; "headless": true,

&nbsp; "slowMo": 0,

&nbsp; "navigationTimeoutSecs": 45

}



