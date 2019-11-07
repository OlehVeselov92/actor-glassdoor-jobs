const Apify = require('apify');
const requestPromise = require('request-promise');
const cheerio = require('cheerio');
const { URL } = require('url');
const Entities = require('html-entities').AllHtmlEntities;

const { log } = Apify.utils;
const { BASE_URL, REQUEST_HEADERS } = require('./consts');

Apify.main(async () => {
    // global variable for loaded cheerio content to keep jQuery-alike syntax
    let $;

    const entities = new Entities(); // encoding-decoding html entities

    const input = await Apify.getInput();
    const proxy = Apify.getApifyProxyUrl();
    const optionsCheerio = {
        transform: (body) => {
            return cheerio.load(body);
        },
        proxy,
        ...REQUEST_HEADERS,
    };

    if (!input || !input.query) {
        throw new Error('INPUT must contain query');
    }

    // if no maxResults specified then parse this amount from first search page
    let { maxResults } = input;
    if (!maxResults) {
        maxResults = -1;
    } else if (typeof maxResults === 'string') {
        maxResults = parseInt(input.maxResults, 10);
    }

    // location is optional, if specified we need to get available options from location search
    if (typeof input.location === 'string') {
        // results limited to 1 since we will not use more than 1
        const locations = await requestPromise({
            uri: new URL(`/findPopularLocationAjax.htm?term=${input.location}&maxLocationsToReturn=1`, BASE_URL),
            json: true,
            proxy,
            ...REQUEST_HEADERS,
        });
        if (locations.length > 0) {
            // expected output format
            // [{"compoundId":"C1132348","countryName":"United States","id":"C1132348","label":"New York, NY (US)",
            // "locationId":1132348,"locationType":"C","longName":"New York, NY (US)","realId":1132348}]
            input.location = `&locT=${locations[0].locationType}&locId=${locations[0].locationId}&locKeyword=${input.location}`;
            log.info(`Found location ${input.location}`);
        } else {
            throw new Error(`No locations found for ${input.location}`);
        }
    } else {
        throw new Error(`Incorrect locations value ${input.location}`);
    }

    /*
    4 options available to search with: Jobs, Companies, Salaries, Interviews
    only Jobs and Companies are used because other two do not fit data model
    */
    let search;
    if (input.category === 'Companies') {
        search = '/Reviews/company-reviews.htm';
    } else {
        search = '/Job/jobs.htm';
        input.category = 'Jobs';
    }

    let page = 1;
    let savedItems = 0;
    let rawdata;
    let json;
    let limitRetries = 0;
    let nextPageUrl = `${search}?sc.keyword=${input.query}${input.location}&srs=RECENT_SEARCHES`;

    // mapping for items in the jobs search list
    const mapJobListItem = (i, el) => {
        return {
            id: $(el).data('id'),
            employerName: $('div.jobInfoItem.jobEmpolyerName', el).text(),
            employerRating: parseFloat($('span.compactStars', el).text()),
            jobTitle: $('a', el).last().text(),
            jobLocation: $('span.subtle.loc', el).text(), // div.jobInfoItem.empLoc includes tooltips like "hot" or "easy hire"
            url: BASE_URL + $('a', el).attr('href'),
            jobDetails: '',
            companyDetails: '',
            salary: $('span.salaryText', el).text().trim(),
        };
    };

    // mapping for items in the companies reviews list
    const mapReviewListItem = (i, el) => {
        // original urls like /Overview/Working-at-Web-com-EI_IE12965.11,18.htm
        // should be changed to company jobs urls like /Jobs/Web-com-Jobs-E12965.htm
        const url1 = $('div.margBotXs a', el).attr('href');
        let url2 = url1.replace('Overview/Working-at-', 'Jobs/');
        const indA = url2.indexOf('-EI_IE');
        const indB = url2.indexOf('.', indA);
        url2 = url2.substr(0, indB);
        url2 = `${url2.replace('-EI_IE', '-Jobs-E')}.htm`;
        return {
            id: $(el).data('emp-id'),
            employerName: $('div.margBotXs a', el).text().trim(),
            employerRating: parseFloat($('span.bigRating.strong.margRtSm.h1', el).text()),
            url: url2,
        };
    };

    /*
    * Get search results first
    * then crawl subpages to get details
    */
    const searchResults = [];
    const reviewResults = [];
    // if no limit for results, then parse it from the initial search
    let maximumResults = maxResults > 0 ? maxResults : -1;
    const searchUrl = new URL(nextPageUrl, BASE_URL);

    if (input.category === 'Companies') {
        do {
            try {
                log.info(`GET ${searchUrl}`);
                $ = await requestPromise({
                    uri: searchUrl,
                    ...optionsCheerio,
                });
                if (maximumResults < 0) {
                    const cntStr = $('strong', 'div.count.margBot.floatLt.tightBot').last().text().replace(',', '');
                    maximumResults = parseInt(cntStr, 10);
                    if (!(maximumResults > 0)) {
                        throw new Error(`Failed to parse companies count from ${cntStr}`);
                    }
                    log.info(`Parsed maximumResults = ${maximumResults}`);
                }
                rawdata = $('div.eiHdrModule');
                json = rawdata
                    .map(mapReviewListItem)
                    .get();
            } catch (error) {
                if (error.statusCode === 504 && limitRetries < 5) {
                    log.info(' - Encountered rate limit, waiting 3 seconds');
                    await Apify.utils.sleep(3000);
                    limitRetries++;
                    continue; // eslint-disable-line
                } else {
                    // Rethrow non rate-limit errors or if we are stuck
                    throw error;
                }
            }

            const itemsToSave = json.slice(0, maximumResults - savedItems);
            reviewResults.push(...itemsToSave);
            savedItems += itemsToSave.length;
            nextPageUrl = $('li.next a', '#FooterPageNav').attr('href');
            log.info(`Page ${page}: Found ${itemsToSave.length} items, next page: ${nextPageUrl}`);
            page++;
        } while (nextPageUrl && savedItems < maximumResults);

        // crawl company reviews to get jobs
        const requestList = new Apify.RequestList({
            sources: reviewResults.map(x => ({ url: BASE_URL + x.url, uniqueKey: x.id.toString() })),
        });
        await requestList.initialize();
        const crawlerJobs = new Apify.BasicCrawler({
            requestList,
            handleRequestFunction: async ({ request }) => {
                $ = await requestPromise({
                    url: request.url,
                    ...optionsCheerio,
                });
                const updatedItem = reviewResults.find(x => x.id === parseInt(request.uniqueKey, 10));
                if (!updatedItem) {
                    log.error(`- not found review listing id ${request.uniqueKey} in search results`);
                    return;
                }
                const jobList = $('div.JobsListItemStyles__jobDetailsContainer').get().slice(0, 3);
                log.info(`Preparing ${jobList.length} job(s) for company ${request.url}`);
                for (const el of jobList) {
                    const jobLink = $('.JobDetailsStyles__jobTitle', el);
                    if (!jobLink) {
                        log.error('- no job link element');
                        break;
                    }
                    const jobText = $('.JobDetailsStyles__iconLink', el).text();
                    const jobRef = jobLink.attr('href');
                    let jobId = jobRef.match(/jobListingId=([^&]+)/);
                    if (!jobRef || !jobId) {
                        log.error(`- job link ${jobRef} corrupted: ${jobLink.parent().html()}`);
                        break;
                    }
                    jobId = parseInt(jobId[1], 10);
                    // IMPORTANT - need one more call to get direct job link
                    // jobLink.attr('href') leads to another job list with preselected item
                    const listPageUrl = BASE_URL + jobRef;
                    log.info(`parsing ${listPageUrl}`);
                    const page2 = await requestPromise({
                        url: listPageUrl,
                        ...optionsCheerio,
                    });
                    rawdata = page2('script[type="application/ld+json"]').html();
                    json = JSON.parse(rawdata);
                    if (!json && !json.itemListElement) {
                        log.error('- jobs list not found!');
                        break;
                    }
                    const jobItem = json.itemListElement[0];
                    if (jobItem) {
                        // transform to the same data object as we getting from job search results
                        const jobResult = {
                            ...updatedItem,
                            id: jobId,
                            url: jobItem.url,
                            jobTitle: jobText,
                        };
                        searchResults.push(jobResult);
                        log.info(`set to reparse from ${jobItem.url}`);
                    } else {
                        log.error('Job item not found!');
                    }
                }
            },
        });
        await crawlerJobs.run();
    } else { // input.category === 'Jobs'
        do {
            try {
                log.info(`GET ${searchUrl}`);
                $ = await requestPromise({
                    uri: searchUrl,
                    ...optionsCheerio,
                });
                if (maximumResults < 0) {
                    const cntStr = $('p.jobsCount').text().replace(',', '');
                    maximumResults = parseInt(cntStr, 10);
                    if (!(maximumResults > 0)) {
                        throw new Error(`Failed to parse jobsCount from ${cntStr}`);
                    }
                    log.info(`Parsed maximumResults = ${maximumResults}`);
                }
                rawdata = $('li.jl');
                json = rawdata
                    .map(mapJobListItem)
                    .get();
            } catch (error) {
                if (error.statusCode === 504 && limitRetries < 5) {
                    log.info(' - Encountered rate limit, waiting 3 seconds');
                    await Apify.utils.sleep(3000);
                    limitRetries++;
                    continue; // eslint-disable-line
                } else {
                    // Rethrow non rate-limit errors or if we are stuck
                    throw error;
                }
            }

            const itemsToSave = json.slice(0, maximumResults - savedItems);
            searchResults.push(...itemsToSave);
            savedItems += itemsToSave.length;
            nextPageUrl = $('li.next a', '#FooterPageNav').attr('href');
            log.info(`Page ${page}: Found ${itemsToSave.length} items, next page: ${nextPageUrl}`);
            page++;
        } while (nextPageUrl && savedItems < maximumResults);
    }

    // at this point we have links to jobs in searchResults
    // either from direct jobs search or from companies reviews then from jobs subsection in company page
    const checkUnique = [...new Set(searchResults.map(x => x.id))];
    log.info(`Found ${checkUnique.length} unique listings out of ${searchResults.length} in total`);

    if (searchResults.length === 0) {
        log.error('No results from search!');
        return;
    }

    const requestList = new Apify.RequestList({
        sources: searchResults.map(x => ({ url: x.url, uniqueKey: x.id.toString() })),
    });
    await requestList.initialize();

    // keep parsed details from company overview to avoid extra calls
    const companyDetails = {};

    const crawler = new Apify.BasicCrawler({
        requestList,
        handleRequestFunction: async ({ request }) => {
            log.info(`job GET ${request.url}`);
            $ = await requestPromise({
                url: request.url,
                ...optionsCheerio,
            });
            rawdata = $('script[type="application/ld+json"]').html();
            const cleanstr = rawdata.replace(/\s+/g, ' ').trim();
            json = JSON.parse(cleanstr);
            const updatedItem = searchResults.find(x => x.id === parseInt(request.uniqueKey, 10));
            if (!updatedItem) {
                log.error(`Not found job listing id ${request.uniqueKey} in search results`);
                return;
            }

            // remove html formatting from job description
            let clearDetails = json.description;
            try {
                clearDetails = entities.decode(clearDetails); // this will transform html decoded content to plain html
                clearDetails = $(clearDetails).text(); // then we create html from content and getting it as plain text
            } catch (err) {
                log.error(err);
            }

            // get employer id, check if we have cached overview
            const eid = $('#EmpHero').data('employer-id');
            let moreDetails = companyDetails[eid];
            if (!moreDetails) {
                moreDetails = {};
                // get company details from company overview page
                const companyUrl = new URL($('div.logo.cell a').attr('href'), BASE_URL);
                log.info(`company overview GET ${companyUrl}`);
                $ = await requestPromise({
                    url: companyUrl,
                    ...optionsCheerio,
                });
                $('div.infoEntity', '#EmpBasicInfo').each((i, el) => {
                    const infoKey = $('label', el).text().trim();
                    const info = $('span', el).text().trim();
                    if (infoKey && info) {
                        moreDetails[infoKey] = info;
                    }
                });
                companyDetails[eid] = moreDetails;
            }

            log.info(`Saving details for job listing id ${request.uniqueKey}`);
            // unified output based on list item and sub page
            await Apify.pushData({
                ...updatedItem,
                url: json.url,
                salary: json.estimatedSalary,
                jobLocation: json.jobLocation,
                companyDetails: { ...json.hiringOrganization, ...moreDetails },
                jobDetails: clearDetails,
                datePosted: json.datePosted,
            });
        },
        /*
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                '#isFailed': true,
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
        */
    });
    await crawler.run();

    log.info(`Parsed ${checkUnique.length} items in total`);
});