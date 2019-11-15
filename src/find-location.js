const Apify = require('apify');
const requestPromise = require('request-promise');

const { log } = Apify.utils;
const { BASE_URL, REQUEST_HEADERS } = require('./consts');

const findGlassdoorLocation = async (locationText, locationState, proxy) => {

    if (!locationText) {
        return '';
    }

    // results limited to 1 since we will not use more than 1
    const locations = await requestPromise({
        uri: new URL(`/findPopularLocationAjax.htm?term=${locationText}&maxLocationsToReturn=10`, BASE_URL),
        json: true,
        ...REQUEST_HEADERS,
        proxy,
    });
    if (locations.length > 0) {
        // expected output format
        // [{"compoundId":"C1132348","countryName":"United States","id":"C1132348","label":"New York, NY (US)",
        // "locationId":1132348,"locationType":"C","longName":"New York, NY (US)","realId":1132348}]
        let locIndex = -1;
        // there is no separate value for state, instead state is the part of longName i.e.
        // "Yorktown, VA (US)"
        if (locationState && typeof locationState === 'string') {
            locIndex = locations.findIndex(x => x.longName.includes(`, ${locationState} (`));
        }
        const foundLocation = locations[locIndex >= 0 ? locIndex : 0];
        locationText = `&locT=${foundLocation.locationType}&locId=${foundLocation.locationId}&locKeyword=${locationText}`;
    } else {
        throw new Error(`No locations found for ${locationText}`);
    }

    log.info(`Found location: ${locationText}`);
    return locationText;
};

module.exports = {
    findGlassdoorLocation,
};