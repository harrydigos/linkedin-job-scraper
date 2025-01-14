import { chromium, Page } from "playwright";
import { browserDefaults, LI_URLS, SELECTORS } from "./constants";
import { retry } from "./utils";
import { jobDataExtractor } from "./job-data-extractor";

class LinkedInScraper {
  private _page: Page | null = null;
  private _screenshotCount = 1;

  private async _takeScreenshot(log = "Taking screenshot...") {
    console.log(`📷 ${log}`);
    await this._page?.screenshot({
      path: `screenshots/${this._screenshotCount.toString().padStart(5, "0")}_page.png`,
      fullPage: true,
    });
    this._screenshotCount++;
  }

  private async _isLoggedIn() {
    return !!(await this._page
      ?.locator(SELECTORS.activeMenu)
      .first()
      .isVisible());
  }

  private async _paginate(paginationSize = 25) {
    if (!this._page) {
      throw new Error("🔴 Failed to load page");
    }

    const url = new URL(this._page.url());
    const offset = parseInt(url.searchParams.get("start") || "0", 10);
    url.searchParams.set("start", `${offset + paginationSize}`);

    await this._page.goto(url.toString(), {
      waitUntil: "load",
    });
  }

  async initialize(liAtCookie: string) {
    console.log("🟡 Connecting to a scraping browser");

    const browser = await chromium.launch(browserDefaults);

    console.log("🟢 Connected, navigating...");

    const ctx = await browser.newContext();

    await ctx.addCookies([
      {
        name: "li_at",
        value: liAtCookie,
        domain: ".linkedin.com",
        path: "/",
      },
    ]);

    this._page = await ctx.newPage();

    await this._page.goto(LI_URLS.home);

    if (!this._isLoggedIn()) {
      await this._takeScreenshot("🔴 Authentication failed");
      throw new Error(
        "🔴 Authentication failed. Please check your li_at cookie.",
      );
    }

    console.log("🟢 Successfully authenticated!");
    await this._takeScreenshot("Home page");
  }

  private async _loadJobs() {
    return retry(
      async () => {
        if (!this._page) {
          throw new Error("🔴 Failed to load page");
        }

        // Wait for all the skeletons to be removed before starting to scroll
        await Promise.allSettled(
          SELECTORS.jobCardSkeletons.map((selector) =>
            this._page?.waitForSelector(selector, {
              timeout: 3000,
              state: "detached",
            }),
          ),
        );

        const getCount = () => this._page!.locator(SELECTORS.jobs).count();
        const getLastLocator = () => this._page!.locator(SELECTORS.jobs).last();

        let count = await getCount();
        let lastItemLocator = getLastLocator();

        // Keep scrolling to the last item into view until no more items are loaded
        while (true) {
          await lastItemLocator.scrollIntoViewIfNeeded();
          await this._page.waitForTimeout(200);

          const currentCount = await getCount();

          if (currentCount === count) {
            break; // No new items loaded, exit
          }

          count = currentCount;
          lastItemLocator = getLastLocator();
        }

        return { success: true as boolean, totalJobs: count };
      },
      {
        maxAttempts: 3,
        delayMs: 300,
        timeout: 30000,
      },
    );
  }

  async searchJobs(keywords: string, location: string, limit = 25) {
    if (!this._page) throw new Error("🔴 Scraper not initialized");

    const searchUrl = `${LI_URLS.jobsSearch}?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}`;

    await this._page.goto(searchUrl, { waitUntil: "load" });

    await this._takeScreenshot("Search jobs page");

    let processedJobs = 0;

    while (processedJobs < limit) {
      const { totalJobs, success: jobsSuccess } = await this._loadJobs();
      console.log({ totalJobs });

      if (!jobsSuccess) {
        await this._takeScreenshot("🔴 No jobs found");
        return [];
      }

      const res = await jobDataExtractor.extractJobCardsData(this._page);
      processedJobs += res.length;
      console.log(res);

      if (processedJobs >= limit) {
        await this._takeScreenshot("🟢 Job limit reached");
        break;
      }

      await this._paginate();
    }
    console.log(jobDataExtractor.cachedJobs.values());
  }

  async close() {
    if (this._page) {
      await this._page.context().browser()?.close();
      this._page = null;
    }
  }
}

export { LinkedInScraper };
