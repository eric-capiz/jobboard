/* Industry data for JobBoard.
 *
 * SWEEP_ROSTER is the sweep universe: every industry from the master
 * company lists, with the companies tagged to it (plus the companies
 * checked on their own careers pages during the sweep and every company
 * that has landed on the board). Jobs don't carry an industry field, so a
 * job's industry is resolved from its company via this roster. Companies
 * in no roster fall back to "Other" — add new finds to the roster when
 * they are imported. */
import type { Job, Stage } from '../domain';

export const FALLBACK_INDUSTRY = 'Other';

/** Industry name -> companies in the sweep tagged with that industry. */
export const SWEEP_ROSTER: Record<string, string[]> = {
 "Space": [
  "Axiom Space",
  "Blue Origin",
  "Firefly Aerospace",
  "Intuitive Machines",
  "Relativity Space",
  "Rocket Lab",
  "Sierra Space",
  "SpaceX",
  "Virgin Galactic"
 ],
 "Aviation/eVTOL": [
  "Archer Aviation",
  "Joby Aviation"
 ],
 "Aviation": [
  "Boom Supersonic"
 ],
 "Airlines": [
  "Alaska Airlines",
  "American Airlines",
  "Delta Air Lines",
  "Frontier Airlines",
  "JetBlue",
  "Southwest Airlines",
  "United Airlines"
 ],
 "Rail": [
  "Amtrak",
  "CSX",
  "Norfolk Southern",
  "Union Pacific"
 ],
 "Rail Tech": [
  "Wabtec"
 ],
 "Shipping": [
  "Crowley Maritime",
  "Matson"
 ],
 "Transit Tech": [
  "Via Transportation"
 ],
 "Warehousing": [
  "GXO Logistics"
 ],
 "Cold Storage": [
  "Americold",
  "Lineage Logistics"
 ],
 "Logistics": [
  "DHL Supply Chain US",
  "FedEx",
  "J.B. Hunt",
  "Schneider",
  "Schneider National",
  "UPS",
  "XPO"
 ],
 "Moving/Storage": [
  "PODS",
  "U-Haul"
 ],
 "Moving": [
  "Two Men and a Truck"
 ],
 "Moving Tech": [
  "Bellhop"
 ],
 "Energy": [
  "GE Vernova"
 ],
 "Renewables": [
  "Clearway Energy",
  "Invenergy",
  "Nexamp",
  "Orsted US",
  "Vestas Americas"
 ],
 "Nuclear": [
  "NuScale Power",
  "Oklo",
  "TerraPower",
  "Westinghouse",
  "X-energy"
 ],
 "Nuclear/Defense": [
  "BWXT"
 ],
 "Mining": [
  "Freeport-McMoRan",
  "KoBold Metals",
  "Newmont"
 ],
 "Steel/Mining": [
  "Cleveland-Cliffs"
 ],
 "Steel": [
  "Nucor",
  "US Steel"
 ],
 "Metals": [
  "Alcoa"
 ],
 "Mining/Coal": [
  "Peabody Energy"
 ],
 "Mining/Rare Earths": [
  "MP Materials"
 ],
 "Food Industry": [
  "ADM",
  "Bimbo Bakeries USA",
  "Campbell's",
  "Cargill",
  "Chobani",
  "Conagra Brands",
  "Danone North America",
  "Flowers Foods",
  "General Mills (retry)",
  "Hershey",
  "Hormel Foods",
  "Impossible Foods",
  "J.M. Smucker",
  "JBS USA / Pilgrim's",
  "Kellanova (Kellogg's)",
  "Kraft Heinz (retry)",
  "Land O'Lakes",
  "McCormick",
  "Mondelez",
  "PepsiCo (retry)",
  "Perdue Farms",
  "Smithfield Foods",
  "Tillamook",
  "Vital Farms"
 ],
 "Agriculture/Pharma": [
  "Bayer US"
 ],
 "Agriculture": [
  "CHS Inc",
  "Driscolls",
  "The Wonderful Company"
 ],
 "Agriculture/Dairy": [
  "Land O Lakes"
 ],
 "Agriculture/Food": [
  "Dole"
 ],
 "Ag/Geo Tech": [
  "Trimble"
 ],
 "Construction": [
  "Bechtel",
  "DPR Construction",
  "Kiewit",
  "Mortenson",
  "Skanska USA",
  "Turner Construction"
 ],
 "Building Materials": [
  "Beacon Building",
  "Builders FirstSource",
  "Fortune Brands",
  "Martin Marietta",
  "Masco",
  "Owens Corning",
  "Vulcan Materials"
 ],
 "Forestry": [
  "Weyerhaeuser"
 ],
 "Forestry/Paper": [
  "Georgia-Pacific",
  "International Paper"
 ],
 "Packaging": [
  "Ball Corporation",
  "Sonoco"
 ],
 "Hotels": [
  "Choice Hotels",
  "Hilton",
  "IHG Hotels",
  "Marriott International",
  "Wyndham Hotels"
 ],
 "Travel Tech": [
  "Hopper",
  "Sabre",
  "Travelport"
 ],
 "Travel": [
  "Booking.com",
  "Expedia",
  "Tripadvisor",
  "TripSuite"
 ],
 "Sports Tech": [
  "Hudl",
  "TeamSnap"
 ],
 "Sports Data": [
  "Genius Sports",
  "Sportradar US"
 ],
 "Sports": [
  "NASCAR",
  "NCAA",
  "PGA Tour",
  "US Olympic Committee"
 ],
 "Sports Entertainment": [
  "TKO / UFC / WWE"
 ],
 "Nonprofit": [
  "American Cancer Society",
  "American Heart Association",
  "American Red Cross",
  "Feeding America",
  "Goodwill Industries",
  "Habitat for Humanity",
  "Make-A-Wish"
 ],
 "Nonprofit/Health": [
  "St Jude / ALSAC"
 ],
 "Nonprofit (Veterans)": [
  "Wounded Warrior Project"
 ],
 "Nonprofit/Association": [
  "AARP"
 ],
 "Nonprofit/Education": [
  "Teach For America"
 ],
 "Nonprofit News": [
  "ProPublica"
 ],
 "Death Care": [
  "Service Corp Intl (funeral)"
 ],
 "Weddings": [
  "The Knot Worldwide",
  "Zola"
 ],
 "Baby Registry": [
  "Babylist"
 ],
 "Genealogy": [
  "Ancestry"
 ],
 "Language Learning": [
  "Duolingo"
 ],
 "Dating": [
  "Bumble Inc",
  "Grindr",
  "Match Group"
 ],
 "Creator Economy": [
  "Cameo",
  "Gumroad",
  "Kajabi"
 ],
 "Weather": [
  "AccuWeather",
  "The Weather Company"
 ],
 "Weather/Ag Data": [
  "DTN"
 ],
 "GIS/Mapping": [
  "Esri"
 ],
 "Mapping": [
  "HERE Technologies US"
 ],
 "Geo Tech": [
  "EagleView"
 ],
 "Fitness Tech": [
  "Strava"
 ],
 "Social/Local": [
  "Nextdoor",
  "Reddit"
 ],
 "Events": [
  "Eventbrite",
  "Meetup"
 ],
 "Insurance SaaS": [
  "Applied Systems",
  "BriteCore",
  "Duck Creek",
  "Guidewire",
  "Sapiens US",
  "Vertafore",
  "Zywave"
 ],
 "Insurtech": [
  "Branch Insurance",
  "Hippo Insurance",
  "Kin Insurance",
  "Openly",
  "Root Insurance"
 ],
 "Banking Tech": [
  "Alkami",
  "Jack Henry",
  "MeridianLink",
  "nCino (retry)",
  "Q2 (retry)"
 ],
 "Fintech": [
  "Affirm",
  "DualEntry",
  "Fintros",
  "FIS",
  "FIS (retry)",
  "Fiserv",
  "Fiserv (retry)",
  "GBI",
  "Happy Money",
  "LetsVenture",
  "PayPal",
  "SoFi"
 ],
 "Mortgage Tech": [
  "ICE Mortgage"
 ],
 "Payments": [
  "Global Payments",
  "Nuvei US",
  "Paysafe US",
  "Shift4"
 ],
 "Tech": [
  "15Five",
  "AppFolio",
  "AppMySite",
  "Asana",
  "Canva",
  "ClickUp",
  "Coda",
  "CompanyCam",
  "Customertimes",
  "Deel",
  "Drift",
  "Framer",
  "Freshworks",
  "Gong",
  "Google",
  "Ipsator",
  "Lattice",
  "Lightspeed",
  "Microsoft",
  "Miro",
  "NTT DATA",
  "Oowlish Technology",
  "Procore",
  "Remote.com",
  "Retool",
  "Salesloft",
  "Smartsheet",
  "Snap",
  "Toast",
  "Unifonic",
  "uvation",
  "Webflow",
  "Zoo Corporation"
 ],
 "Telecom": [
  "AT&T",
  "Brightspeed",
  "C Spire",
  "Charter / Spectrum",
  "Charter Communications",
  "Comcast",
  "Dish / EchoStar",
  "Frontier Communications",
  "Lumen",
  "Lumen (retry)",
  "T-Mobile",
  "TDS Telecom",
  "UScellular",
  "Verizon",
  "Windstream"
 ],
 "Defense": [
  "Amentum",
  "BAE Systems",
  "BAE Systems US",
  "Booz Allen Hamilton",
  "CACI",
  "GDIT (General Dynamics IT)",
  "KBR",
  "L3Harris",
  "Leidos",
  "Lockheed Martin",
  "ManTech",
  "Northrop Grumman",
  "Peraton",
  "RTX",
  "RTX (Raytheon)",
  "SAIC"
 ],
 "GovCon": [
  "Booz Allen (retry)",
  "GDIT",
  "General Dynamics IT",
  "V2X"
 ],
 "GovCon/Engineering": [
  "Parsons"
 ],
 "Defense/Shipbuilding": [
  "HII"
 ],
 "GovCon (Native Corp)": [
  "ASRC Federal"
 ],
 "Healthcare": [
  "AdventHealth",
  "Ascension",
  "Banner Health",
  "Centene",
  "Cigna",
  "Cleveland Clinic",
  "CommonSpirit Health",
  "Elevance Health",
  "Geisinger",
  "HCA Healthcare",
  "Humana",
  "Intermountain Health",
  "Kaiser Permanente",
  "Mayo Clinic",
  "Northwell Health",
  "Providence",
  "Sutter Health",
  "UnitedHealth Group / Optum",
  "UPMC"
 ],
 "Health Insurance": [
  "Humana (retry)",
  "Molina Healthcare",
  "UnitedHealth Group"
 ],
 "Health/PBM": [
  "CVS Health (retry)"
 ],
 "PBM": [
  "Prime Therapeutics"
 ],
 "PBM Tech": [
  "Capital Rx",
  "Rightway",
  "SmithRx"
 ],
 "PEO/HR": [
  "Insperity",
  "Paychex (retry)",
  "TriNet"
 ],
 "PEO": [
  "Barrett Business"
 ],
 "Staffing": [
  "Adecco",
  "Allegis / TEKsystems",
  "AMN Healthcare",
  "Apex Systems",
  "Aquent",
  "Aya Healthcare",
  "Beacon Hill",
  "CHG Healthcare",
  "CommIT",
  "Creative Circle",
  "Everest Technologies",
  "Express Employment",
  "Ginas Tech Jobs",
  "Hivex",
  "Human Power BG",
  "Insight Global",
  "IO Tech Solutions Limited",
  "Jobot",
  "Jobs for Humanity",
  "Kelly Services",
  "Kforce",
  "Korn Ferry",
  "lemon.io",
  "Madiff",
  "ManpowerGroup",
  "MENA Alliances",
  "mercor",
  "Motion Recruitment",
  "Nearshore Business Solutions",
  "OnHires",
  "PradeepIT Consulting Services Pvt Ltd",
  "ProDev",
  "Randstad USA",
  "Robert Half",
  "Staffmark / Advantage",
  "Startup Talents",
  "Stateside",
  "Talent Journey",
  "TransilvaniaHR",
  "TrueBlue",
  "Truelogic",
  "Vaco",
  "WOW Remote Teams",
  "Xperteez Technology"
 ],
 "Staffing (Healthcare)": [
  "Cross Country Healthcare",
  "HealthTrust / HCA Workforce",
  "Jackson Healthcare"
 ],
 "Venue Management": [
  "ASM Global",
  "Centene Community Ice / venue ops",
  "Oak View Group (retry)",
  "Pinnacle Venue Services",
  "Spectra (Comcast Spectacor)",
  "VenuWorks"
 ],
 "Venue/Hospitality": [
  "Delaware North",
  "Legends Global"
 ],
 "Venue Hospitality": [
  "Aramark Sports (retry)",
  "Levy (Compass)",
  "Sodexo Live"
 ],
 "Venues/Entertainment": [
  "Madison Square Garden Entertainment"
 ],
 "Sports/Venues": [
  "Madison Square Garden Sports"
 ],
 "Sports Group": [
  "Dallas Cowboys / Legends JV",
  "Fenway Sports Group",
  "Harris Blitzer Sports & Entertainment",
  "Kroenke Sports & Entertainment",
  "Monumental Sports & Entertainment",
  "Spurs Sports & Entertainment",
  "Tepper Sports & Entertainment",
  "Vinik Sports Group",
  "Yankee Global Enterprises"
 ],
 "Sports/Entertainment": [
  "Ilitch Companies"
 ],
 "Sports Consulting": [
  "SEI / Elevate Sports Ventures"
 ],
 "Sports Media/Rights": [
  "Learfield",
  "Playfly Sports"
 ],
 "Sports Marketing": [
  "Octagon"
 ],
 "Sports Agency": [
  "CAA Sports (retry)",
  "Excel Sports Management"
 ],
 "Sports Agency/Media": [
  "Wasserman"
 ],
 "Ticketing": [
  "AudienceView",
  "AXS",
  "Etix",
  "Front Gate Tickets",
  "Project Admission",
  "SeatGeek",
  "StubHub",
  "TixTrack",
  "Vivenu US",
  "Vivid Seats"
 ],
 "Ticketing (College Sports)": [
  "Paciolan"
 ],
 "Venue Tech": [
  "accesso",
  "Jump (venue fan platform)",
  "Moment / venue NFTs"
 ],
 "Ticketing (Music)": [
  "DICE"
 ],
 "Sports Ticketing Tech": [
  "FEVO"
 ],
 "Venue Parking Tech": [
  "ParkHub"
 ],
 "Ticketing (Arts Venues)": [
  "Spektrix US"
 ],
 "Venue CRM/Ticketing": [
  "Tessitura Network"
 ],
 "Ticket Exchange": [
  "Lyte"
 ],
 "Venue POS/Tech": [
  "VenueNext (Shift4)"
 ],
 "Venue POS": [
  "Appetize (SpotOn)"
 ],
 "Venue Payments": [
  "Shift4 Sports & Entertainment (retry)"
 ],
 "Venue Identity Tech": [
  "CLEAR (stadium entry)"
 ],
 "Venue Facial Entry": [
  "Wicket"
 ],
 "Stadium Security Tech": [
  "CEIA USA / Garrett",
  "Evolv Technology",
  "Xtract One"
 ],
 "Venue Staffing/Security": [
  "Best Crowd Management"
 ],
 "Venue Security": [
  "CSC Contemporary Services"
 ],
 "Venue Staffing": [
  "Argus Event Staffing",
  "Landmark Event Staffing"
 ],
 "Grocery": [
  "Ahold Delhaize",
  "Albertsons",
  "ALDI US",
  "BJ's Wholesale",
  "Giant Eagle",
  "H-E-B",
  "Hy-Vee",
  "Kroger",
  "Meijer",
  "Publix",
  "Sprouts Farmers Market",
  "Wegmans"
 ],
 "Retail/Tech": [
  "Amazon",
  "Shopistry"
 ],
 "Restaurants": [
  "Bloomin Brands",
  "Brinker International",
  "Chick-fil-A",
  "Chipotle",
  "Darden",
  "Darden Restaurants",
  "Domino's",
  "Inspire Brands",
  "McDonald's",
  "Papa John's",
  "Portillo's",
  "Raising Cane's",
  "Shake Shack",
  "Starbucks",
  "Texas Roadhouse",
  "Wendy's",
  "Whataburger",
  "Wingstop",
  "Yum! Brands"
 ],
 "Car Washes": [
  "GO Car Wash",
  "Mister Car Wash",
  "Quick Quack Car Wash",
  "Tommy's Express",
  "WhiteWater Express",
  "Zips Car Wash"
 ],
 "Car Washes/Auto": [
  "Driven Brands (Take 5)"
 ],
 "Healthcare/Retail": [
  "CVS Health",
  "Walgreens"
 ],
 "Auto": [
  "AutoNation",
  "CarMax",
  "Carvana",
  "Copart",
  "Cox Automotive",
  "Ford",
  "General Motors",
  "Genuine Parts / NAPA",
  "Lithia Motors",
  "LKQ",
  "Lucid Motors",
  "Motional",
  "Rivian",
  "Stellantis",
  "Tesla",
  "Toyota North America"
 ],
 "Auto/Tires": [
  "Discount Tire",
  "Goodyear"
 ],
 "Auto Services": [
  "Valvoline"
 ],
 "Auto Repair": [
  "Caliber Collision",
  "Safelite"
 ],
 "Retail": [
  "Abercrombie & Fitch",
  "Academy Sports",
  "American Eagle",
  "Barnes & Noble",
  "Burlington",
  "Costco",
  "Dollar General",
  "Dollar Tree",
  "Five Below",
  "Foot Locker",
  "Home Depot",
  "Kohl's",
  "Levi's",
  "Lowe's",
  "Nordstrom",
  "Ross Stores",
  "Signet Jewelers",
  "Tapestry (Coach)",
  "Target",
  "TJX",
  "Urban Outfitters",
  "Walmart",
  "Williams Sonoma"
 ],
 "Retail/Furniture": [
  "IKEA US",
  "RH",
  "Williams-Sonoma"
 ],
 "Toys": [
  "Build-A-Bear",
  "Funko",
  "Hasbro",
  "Jazwares",
  "LEGO",
  "Mattel",
  "Melissa & Doug",
  "Spin Master"
 ],
 "Toys/Gaming": [
  "Nintendo of America"
 ],
 "Furniture": [
  "Arhaus",
  "Ashley Furniture",
  "Crate & Barrel",
  "La-Z-Boy",
  "Mattress Firm",
  "MillerKnoll",
  "Rooms To Go",
  "Sleep Number",
  "Steelcase",
  "Wayfair"
 ],
 "Furniture/Rentals": [
  "Aaron's"
 ],
 "Home Services": [
  "Angi",
  "Authority Brands",
  "Fixer",
  "Frontdoor",
  "Neighborly",
  "TaskRabbit",
  "Thumbtack"
 ],
 "Repairs": [
  "Roto-Rooter / Chemed",
  "Stanley Steemer"
 ],
 "Pest Control": [
  "Aptive Environmental",
  "Rentokil / Terminix",
  "Rollins / Orkin",
  "Terminix / Rentokil"
 ],
 "Lawn Care": [
  "TruGreen"
 ],
 "Education": [
  "Amplify",
  "Arizona State University",
  "Articulate",
  "Bright Horizons",
  "Chegg",
  "CircleIn",
  "College Board",
  "Curriculum Associates",
  "Docebo",
  "Ellucian",
  "ETS",
  "Grand Canyon Education",
  "Imagine Learning",
  "Instructure",
  "IXL Learning",
  "Kaplan",
  "KinderCare",
  "MasterClass",
  "McGraw Hill",
  "Nerdy / Varsity Tutors",
  "Ohio State University",
  "Pearson",
  "Penn State",
  "PowerSchool",
  "Renaissance Learning",
  "Scholastic",
  "Skillshare",
  "Stride (K12)",
  "Sylvan Learning",
  "Udemy"
 ],
 "Telecom/Tech": [
  "Qualcomm"
 ],
 "Banks": [
  "Ally Financial",
  "Bank of America",
  "Capital One",
  "Citibank",
  "Citizens Bank",
  "Discover",
  "Fifth Third",
  "JPMorgan Chase",
  "Navy Federal",
  "PNC",
  "Synchrony",
  "Truist",
  "US Bank",
  "Wells Fargo"
 ],
 "Banks/Insurance": [
  "USAA"
 ],
 "Insurance": [
  "Allstate",
  "Bjak",
  "Liberty Mutual",
  "Nationwide",
  "Progressive",
  "State Farm",
  "Travelers"
 ],
 "Finance": [
  "American Express",
  "Charles Schwab",
  "Fidelity",
  "Fidelity Investments",
  "Goldman Sachs",
  "Morgan Stanley",
  "Vanguard"
 ],
 "Healthcare/Tech": [
  "GoodRx",
  "Hims & Hers"
 ],
 "Pet": [
  "Mars Petcare / Banfield",
  "Rover"
 ],
 "Fitness": [
  "iFIT",
  "Life Time",
  "Planet Fitness",
  "Xponential Fitness"
 ],
 "Fitness/Tech": [
  "Mindbody"
 ],
 "Food Distribution": [
  "KeHE Distributors",
  "Performance Food Group",
  "SpartanNash",
  "Sysco",
  "UNFI",
  "US Foods"
 ],
 "Beverages": [
  "Coca-Cola",
  "Keurig Dr Pepper",
  "PepsiCo"
 ],
 "Food": [
  "Nestlé USA"
 ],
 "Consumer Goods": [
  "Clorox",
  "Kimberly-Clark",
  "Newell Brands",
  "Procter & Gamble",
  "Unilever"
 ],
 "Tools": [
  "Stanley Black & Decker"
 ],
 "Appliances": [
  "Whirlpool"
 ],
 "Jewelry": [
  "Ben Bridge Jeweler",
  "Blue Nile",
  "Brilliant Earth",
  "Gorjana",
  "Helzberg Diamonds",
  "James Avery",
  "Kendra Scott",
  "Mejuri",
  "Pandora Jewelry",
  "Shane Co",
  "Tiffany & Co (LVMH)"
 ],
 "Jewelry/Accessories": [
  "Claire's"
 ],
 "Apparel": [
  "Adidas",
  "Aritzia",
  "Boot Barn",
  "Caleres (Famous Footwear)",
  "Capri (Michael Kors, Versace)",
  "Carter's",
  "Chico's FAS",
  "Deckers (UGG, Hoka)",
  "Designer Brands (DSW)",
  "Duluth Trading",
  "Express",
  "Fashion Nova",
  "G-III Apparel",
  "Gap",
  "Genesco (Journeys)",
  "H&M US",
  "Hot Topic",
  "J.Crew",
  "L.L.Bean",
  "Lands' End",
  "Lululemon",
  "New Balance",
  "Nike",
  "Oxford Industries (Tommy Bahama)",
  "Puma",
  "PVH (Calvin Klein, Tommy Hilfiger)",
  "Revolve",
  "Steve Madden",
  "The Children's Place",
  "Torrid",
  "Tory Burch",
  "Under Armour",
  "Vera Bradley",
  "Wolverine Worldwide",
  "Zumiez"
 ],
 "Beauty": [
  "Bath & Body Works (retry)",
  "BeautyHealth (Hydrafacial)",
  "Coty",
  "DECIEM (The Ordinary)",
  "e.l.f. Beauty",
  "Estée Lauder",
  "Function of Beauty",
  "Glossier",
  "Inter Parfums",
  "L'Oréal USA",
  "Lush North America",
  "Madison Reed",
  "Mary Kay",
  "Nu Skin",
  "Olaplex",
  "Rare Beauty",
  "Revlon",
  "Sally Beauty",
  "Sephora (LVMH)",
  "Shiseido Americas",
  "Ulta Beauty (retry)"
 ],
 "Beauty Services": [
  "European Wax Center"
 ],
 "Retail/Eyewear": [
  "1-800 Contacts",
  "Sunglass Hut / Luxottica",
  "Warby Parker (retry)"
 ],
 "Agencies": [
  "Bounteous",
  "Critical Mass",
  "Dentsu",
  "DEPT Agency",
  "Directive",
  "Hero Digital",
  "Huge",
  "Interpublic (IPG)",
  "Jellyfish",
  "Monks (S4 Capital)",
  "Omnicom",
  "PMG",
  "Power Digital",
  "Publicis Groupe",
  "SmartBug Media",
  "Stagwell",
  "Tinuiti",
  "Treehouse Strategy and Communications",
  "WebFX",
  "WPP (Ogilvy, VML)",
  "Wpromote"
 ],
 "Field Service SaaS": [
  "FieldEdge",
  "Housecall Pro",
  "Jobber",
  "Service Fusion",
  "ServiceTitan",
  "Workiz",
  "WorkWave"
 ],
 "Tech/Solar": [
  "Aurora Solar",
  "Palmetto Solar"
 ],
 "Windows": [
  "Andersen / Renewal by Andersen",
  "Champion Windows",
  "Cornerstone Building Brands (Ply Gem)",
  "JELD-WEN",
  "Marvin",
  "Masco (Milgard)",
  "Pella",
  "Window Nation",
  "Window World"
 ],
 "Windows/Remodeling": [
  "DaBella",
  "Power Home Remodeling",
  "West Shore Home"
 ],
 "Windows/Home": [
  "Leaf Home (LeafFilter)"
 ],
 "Remodeling": [
  "Bath Fitter"
 ],
 "Solar": [
  "Blue Raven Solar",
  "Enphase Energy",
  "EverBright (NextEra)",
  "First Solar",
  "Freedom Forever",
  "ION Solar",
  "Momentum Solar",
  "Powur",
  "SolarEdge",
  "Sunnova",
  "Sunrun",
  "Trinity Solar"
 ],
 "Solar/Energy": [
  "Generac"
 ],
 "Solar/Tech": [
  "OpenSolar"
 ],
 "Oil & Energy": [
  "Baker Hughes",
  "ConocoPhillips",
  "Devon Energy",
  "EOG Resources",
  "Halliburton",
  "HF Sinclair",
  "Kinder Morgan",
  "Marathon Petroleum",
  "NOV",
  "Occidental Petroleum",
  "Phillips 66",
  "SLB (Schlumberger)",
  "Valero"
 ],
 "Utilities": [
  "CenterPoint Energy",
  "Constellation Energy",
  "Dominion Energy",
  "Duke Energy",
  "Exelon",
  "NextEra Energy",
  "NRG Energy",
  "PG&E",
  "Southern Company",
  "Xcel Energy"
 ],
 "Publishing": [
  "Hachette Book Group",
  "HarperCollins",
  "Informa / Taylor & Francis",
  "Macmillan Publishers",
  "Penguin Random House",
  "RELX / Elsevier",
  "Simon & Schuster",
  "Wiley"
 ],
 "Books Retail": [
  "ThriftBooks"
 ],
 "Magazines": [
  "Condé Nast",
  "Dotdash Meredith"
 ],
 "Magazines/Media": [
  "Hearst"
 ],
 "Media": [
  "Forbes",
  "Fox Corporation",
  "NBCUniversal",
  "Paramount",
  "The Atlantic",
  "Vox Media",
  "Warner Bros Discovery",
  "Ziff Davis"
 ],
 "News": [
  "Associated Press",
  "Axios",
  "Dow Jones / News Corp",
  "Gannett / USA Today",
  "McClatchy",
  "New York Times",
  "Politico",
  "Washington Post"
 ],
 "News/Info": [
  "Bloomberg",
  "Thomson Reuters"
 ],
 "News/Media": [
  "NPR"
 ],
 "News/TV": [
  "Nexstar Media",
  "Scripps",
  "Sinclair Broadcast",
  "TEGNA"
 ],
 "Electronics": [
  "AMD",
  "Analog Devices",
  "Apple",
  "Arista Networks",
  "Broadcom",
  "Corning",
  "Jabil",
  "Logitech",
  "Microchip",
  "Micron",
  "NetApp",
  "Razer",
  "Seagate",
  "Texas Instruments",
  "Western Digital"
 ],
 "Electronics/Industrial": [
  "Emerson"
 ],
 "Electronics Retail": [
  "B&H Photo",
  "Best Buy",
  "Guitar Center",
  "Newegg",
  "Sweetwater"
 ],
 "Electronics/IT Services": [
  "CDW"
 ],
 "IT Services": [
  "Capgemini US",
  "CGI",
  "Cognizant",
  "DXC Technology",
  "EPAM",
  "Globant",
  "Infosys",
  "Insight Enterprises",
  "Presidio",
  "SHI International",
  "WWT"
 ],
 "Outdoors": [
  "Amer Sports (Salomon, Arc'teryx)",
  "Backcountry",
  "Bass Pro Shops / Cabela's",
  "Columbia Sportswear",
  "Helen of Troy (Hydro Flask)",
  "Johnson Outdoors",
  "Patagonia",
  "YETI (retry)"
 ],
 "Marine": [
  "Brunswick (boats)",
  "MarineMax"
 ],
 "Outdoors/RV": [
  "Camping World"
 ],
 "RV": [
  "Thor Industries",
  "Winnebago"
 ],
 "Powersports": [
  "Harley-Davidson",
  "Polaris",
  "Textron (Arctic Cat, E-Z-GO)"
 ],
 "Environmental": [
  "Clean Harbors",
  "Republic Services",
  "Stericycle",
  "Terracon",
  "Tetra Tech",
  "Veolia North America",
  "Waste Connections",
  "WM (Waste Management)"
 ],
 "Engineering": [
  "AECOM",
  "HDR",
  "Jacobs",
  "Stantec"
 ],
 "Environmental Nonprofit": [
  "EDF",
  "NRDC",
  "RMI",
  "The Nature Conservancy"
 ],
 "Hair": [
  "Boardroom Salon",
  "Drybar",
  "Fantastic Sams",
  "Floyd's 99 Barbershop",
  "Great Clips",
  "Hair Cuttery / Ratner",
  "Hammer & Nails",
  "Regis (Supercuts)",
  "Scissors & Scotch",
  "Sport Clips"
 ],
 "Wellness": [
  "Hand & Stone",
  "Massage Envy"
 ],
 "Flooring": [
  "Empire Today",
  "Interface",
  "Mannington Mills",
  "Milliken",
  "Mohawk Industries",
  "MSI ( surfaces)",
  "Shaw Industries"
 ],
 "Flooring/Retail": [
  "Floor & Decor",
  "The Tile Shop"
 ],
 "Real Estate": [
  "Anywhere (Coldwell Banker)",
  "AvalonBay",
  "Compass",
  "CoStar Group",
  "Equity Residential",
  "eXp Realty",
  "Invitation Homes",
  "Keller Williams",
  "Opendoor",
  "RE/MAX"
 ],
 "Real Estate/Property Mgmt": [
  "Greystar"
 ],
 "Homebuilding": [
  "D.R. Horton",
  "KB Home",
  "Lennar",
  "NVR (Ryan Homes)",
  "PulteGroup",
  "Taylor Morrison",
  "Toll Brothers"
 ],
 "Mortgage": [
  "loanDepot",
  "Mr. Cooper",
  "Pennymac",
  "UWM"
 ],
 "Title/Real Estate": [
  "First American"
 ],
 "Title": [
  "Fidelity National Financial"
 ],
 "Museums": [
  "Art Institute of Chicago",
  "California Academy of Sciences",
  "Denver Art Museum",
  "Exploratorium",
  "Field Museum",
  "Getty",
  "History Colorado",
  "MoMA",
  "Perot Museum",
  "Smithsonian Institution",
  "The Met"
 ],
 "Museums/Aquariums": [
  "Georgia Aquarium",
  "Monterey Bay Aquarium",
  "Shedd Aquarium"
 ],
 "Zoos": [
  "Denver Zoo",
  "Houston Zoo",
  "San Diego Zoo Wildlife Alliance",
  "WCS (Bronx Zoo)"
 ],
 "Amusement Parks": [
  "Herschend (Dollywood)",
  "Hershey Entertainment",
  "Merlin Entertainments (LEGOLAND)",
  "Palace Entertainment",
  "Six Flags",
  "United Parks (SeaWorld)"
 ],
 "Amusement/Waterparks": [
  "Great Wolf Resorts",
  "Kalahari Resorts"
 ],
 "Laundry": [
  "Alliance Laundry (Speed Queen)",
  "CSC ServiceWorks",
  "HappyNest Laundry",
  "WASH Multifamily Laundry"
 ],
 "Laundry/Tech": [
  "Poplin",
  "Rinse"
 ],
 "Casinos": [
  "Boyd Gaming",
  "Caesars Entertainment",
  "Hard Rock",
  "MGM Resorts",
  "Penn Entertainment",
  "Wynn Resorts"
 ],
 "Casinos/Sports Betting": [
  "DraftKings (retry)",
  "FanDuel"
 ],
 "Streaming": [
  "Crunchyroll (Sony)",
  "Curiosity Stream",
  "DAZN US",
  "Fubo",
  "Netflix",
  "Philo",
  "Plex",
  "Roku",
  "Tubi (Fox)",
  "Twitch",
  "Vimeo"
 ],
 "Streaming/TV": [
  "AMC Networks"
 ],
 "Streaming/Film": [
  "Lionsgate / Starz"
 ],
 "TV Stations": [
  "Allen Media",
  "Graham Media",
  "Gray Media"
 ],
 "TV/Radio": [
  "Cox Media Group",
  "Entravision",
  "Hubbard Broadcasting"
 ],
 "TV/Streaming": [
  "TelevisaUnivision"
 ],
 "Radio/TV": [
  "Townsquare Media"
 ],
 "Radio": [
  "Audacy",
  "Beasley Media",
  "Cumulus Media",
  "Educational Media Foundation (K-LOVE)",
  "iHeartMedia",
  "Salem Media",
  "Urban One"
 ],
 "Radio/Streaming": [
  "SiriusXM",
  "TuneIn"
 ],
 "Music Streaming": [
  "SoundCloud",
  "Spotify"
 ],
 "Music Labels": [
  "BMG",
  "Concord",
  "Create Music Group",
  "EMPIRE",
  "Kobalt",
  "Sony Music",
  "Universal Music Group",
  "Warner Music Group"
 ],
 "Music Distribution": [
  "DistroKid",
  "The Orchard (Sony)",
  "TuneCore / Believe",
  "UnitedMasters"
 ],
 "Film": [
  "A24",
  "Blumhouse",
  "Legendary Entertainment",
  "NEON",
  "Skydance",
  "Sony Pictures"
 ],
 "Entertainment": [
  "CAA",
  "Disney",
  "UTA",
  "Warner Bros. Discovery",
  "WME / Endeavor"
 ],
 "Live Entertainment": [
  "AEG",
  "Live Nation",
  "Oak View Group"
 ],
 "VFX": [
  "Digital Domain"
 ],
 "Post-Production": [
  "Company 3 / Deluxe"
 ],
 "Gaming": [
  "2K Games",
  "Activision Blizzard",
  "Annapurna Interactive",
  "Aspyr",
  "Bungie",
  "Daybreak Game Company",
  "Devolver Digital",
  "Electronic Arts",
  "Electronic Arts (retry)",
  "Epic Games",
  "Gearbox",
  "Jam City",
  "Kabam",
  "Niantic",
  "PlayStation (Sony Interactive)",
  "Riot Games",
  "Rockstar Games",
  "Scopely",
  "Take-Two Interactive",
  "thatgamecompany",
  "Ubisoft US",
  "Valve",
  "WB Games",
  "Zynga"
 ],
 "Gaming (Casino Tech)": [
  "Aristocrat",
  "Everi",
  "IGT",
  "Light & Wonder"
 ],
 "Gaming (Betting)": [
  "BetMGM",
  "Rush Street Interactive"
 ],
 "Gaming/Tech": [
  "Unity (retry)"
 ],
 "Pharma": [
  "Amgen",
  "Bausch Health",
  "Bristol Myers Squibb",
  "Eli Lilly",
  "Gilead Sciences",
  "Johnson & Johnson",
  "Merck",
  "Organon",
  "Perrigo",
  "Pfizer",
  "Viatris"
 ],
 "Biotech": [
  "10x Genomics",
  "Biogen",
  "Illumina",
  "Moderna",
  "Regeneron",
  "Twist Bioscience",
  "Vertex"
 ],
 "Pharma (Animal)": [
  "Zoetis"
 ],
 "Pharma Services": [
  "Catalent"
 ],
 "Biotech/Life Sciences": [
  "Thermo Fisher"
 ],
 "Life Sciences": [
  "Agilent",
  "Bio-Rad",
  "Danaher",
  "Revvity (PerkinElmer)"
 ],
 "Diagnostics": [
  "Exact Sciences",
  "Guardant Health",
  "Natera"
 ],
 "Biotech/AI": [
  "Recursion",
  "Tempus"
 ],
 "Biotech SaaS": [
  "Benchling"
 ],
 "Medical Devices": [
  "Abbott",
  "Align Technology",
  "Baxter",
  "BD",
  "Boston Scientific",
  "Dexcom",
  "Edwards Lifesciences",
  "GE HealthCare",
  "Hologic",
  "Insulet",
  "Intuitive",
  "Medtronic",
  "ResMed",
  "Stryker",
  "Zimmer Biomet"
 ],
 "Dental Devices": [
  "Dentsply Sirona"
 ],
 "Medical Distribution": [
  "Henry Schein"
 ],
 "Pharma Distribution": [
  "Cardinal Health",
  "Cencora",
  "McKesson"
 ],
 "CRO": [
  "Charles River Labs",
  "Fortrea",
  "ICON",
  "IQVIA",
  "Medpace",
  "Parexel"
 ],
 "CRO/Labs": [
  "Labcorp"
 ],
 "Telehealth": [
  "Amwell",
  "Teladoc Health"
 ],
 "Mental Health": [
  "Grow Therapy",
  "Headspace",
  "LifeStance",
  "Lyra Health",
  "Spring Health",
  "Talkspace"
 ],
 "Behavioral Health": [
  "Acadia Healthcare"
 ],
 "Hospitals": [
  "Community Health Systems",
  "Select Medical",
  "Tenet Healthcare",
  "UHS"
 ],
 "Rehab Hospitals": [
  "Encompass Health"
 ],
 "Senior Care": [
  "Brookdale Senior Living",
  "Ensign Group"
 ],
 "Home Health": [
  "LHC Group / Optum"
 ],
 "Home Care": [
  "BrightSpring Health"
 ],
 "Veterinary Diagnostics": [
  "IDEXX"
 ],
 "AI": [
  "Aidaptive",
  "Anlatan",
  "Anthropic",
  "Cresta",
  "Deepgram",
  "ElevenLabs",
  "Forloop.ai",
  "Glean",
  "Hebbia",
  "Hugging Face",
  "Labelbox",
  "Runway",
  "Scale AI",
  "Weights & Biases",
  "Writer"
 ],
 "AI/Data": [
  "Dataiku",
  "Palantir"
 ],
 "Data": [
  "Domo",
  "Hex",
  "ThoughtSpot"
 ],
 "Cybersecurity": [
  "Abnormal Security",
  "AI2CYBER",
  "Arctic Wolf",
  "CrowdStrike",
  "CyberArk",
  "Dragos",
  "Fortinet",
  "Huntress",
  "KnowBe4",
  "Palo Alto Networks",
  "Rapid7",
  "ReliaQuest",
  "SentinelOne",
  "Tenable",
  "Wiz",
  "Zscaler"
 ],
 "IT Consulting": [
  "Perficient",
  "Thoughtworks"
 ],
 "Consulting": [
  "BCG",
  "Guidehouse",
  "McKinsey",
  "Slalom",
  "ZS Associates"
 ],
 "Accounting": [
  "Baker Tilly",
  "BDO USA",
  "CLA",
  "Grant Thornton",
  "RSM"
 ],
 "Tax Services": [
  "H&R Block"
 ],
 "Fintech/Tax": [
  "Intuit"
 ],
 "HR/Payroll": [
  "ADP",
  "Paychex"
 ],
 "HR SaaS": [
  "Dayforce",
  "Paycom",
  "Paylocity",
  "UKG"
 ],
 "Legal Tech": [
  "Clio",
  "Everlaw",
  "Filevine",
  "Relativity"
 ],
 "Legal Services": [
  "Epiq",
  "LegalZoom"
 ],
 "Legal/Tax Info": [
  "Wolters Kluwer"
 ],
 "HR Tech": [
  "HackerRank",
  "iCIMS",
  "Phenom"
 ],
 "Construction SaaS": [
  "Buildertrend"
 ],
 "Landscape SaaS": [
  "Aspire Software",
  "SingleOps"
 ],
 "Home Services Platform": [
  "Handy",
  "Porch"
 ],
 "Equipment Rental Tech": [
  "EquipmentShare"
 ],
 "Equipment Rental": [
  "BigRentz",
  "Herc Rentals",
  "Sunbelt Rentals",
  "United Rentals"
 ],
 "Landscaping Services": [
  "BrightView"
 ],
 "Tree Services": [
  "Davey Tree"
 ],
 "Fire Protection": [
  "Pye-Barker Fire"
 ],
 "Security Integration": [
  "Convergint"
 ],
 "Elevators": [
  "KONE",
  "Otis Elevator",
  "TK Elevator"
 ],
 "Janitorial Franchise": [
  "Jani-King"
 ],
 "Parking Management": [
  "LAZ Parking",
  "SP Plus"
 ],
 "Parking Tech": [
  "ParkMobile",
  "SpotHero"
 ],
 "Security Services": [
  "Allied Universal"
 ],
 "Security/Armored": [
  "Brinks"
 ],
 "Facilities Services": [
  "ABM Industries"
 ],
 "Facilities/Food Services": [
  "Aramark",
  "Sodexo USA"
 ],
 "Food Services": [
  "Compass Group USA"
 ],
 "Storage/Records": [
  "Iron Mountain"
 ],
 "Building Supply Distribution": [
  "Ferguson"
 ],
 "Electrical Distribution": [
  "Graybar"
 ],
 "Distribution": [
  "WESCO"
 ],
 "Industrial Distribution": [
  "Fastenal (retry)",
  "Grainger (retry)"
 ],
 "Paint/Coatings": [
  "PPG",
  "PPG Industries",
  "Sherwin-Williams",
  "Sherwin-Williams (retry)"
 ],
 "Chemicals/Services": [
  "Ecolab (retry)"
 ],
 "Heavy Machinery": [
  "Caterpillar (retry)"
 ],
 "Ag Machinery": [
  "John Deere (retry)"
 ],
 "Vacation Rentals": [
  "Evolve",
  "Vacasa"
 ],
 "Short-Term Rentals": [
  "Airbnb",
  "AvantStay"
 ],
 "Student Housing": [
  "American Campus Communities",
  "Landmark Properties"
 ],
 "Property Management": [
  "Greystar (retry)"
 ],
 "Pawn Shops": [
  "EZCORP",
  "FirstCash"
 ],
 "Crowdfunding": [
  "GoFundMe",
  "Indiegogo",
  "Republic",
  "Wefunder"
 ],
 "Real Estate Investing": [
  "Fundrise"
 ],
 "Alt Investing": [
  "Masterworks",
  "Yieldstreet"
 ],
 "Online Lending": [
  "Enova"
 ],
 "P2P Lending": [
  "Prosper"
 ],
 "SMB Finance": [
  "BlueVine",
  "Fundbox"
 ],
 "SMB Lending": [
  "Lendio"
 ],
 "Debt Collection": [
  "Encore Capital",
  "PRA Group"
 ],
 "Debt Collection Tech": [
  "TrueAccord"
 ],
 "M&A Platform": [
  "Acquire.com"
 ],
 "Crypto & Web3": [
  "Coinbase",
  "Ethereum Community Fund",
  "Perena",
  "Startale"
 ],
 "Other": [
  "Native",
  "Nexora",
  "Nomina",
  "OOQIA S.A.",
  "Veilant"
 ]
};

/** Normalized company name -> industry, built once from the roster. */
const COMPANY_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [industry, companies] of Object.entries(SWEEP_ROSTER)) {
    for (const company of companies) {
      map.set(company.trim().toLowerCase(), industry);
    }
  }
  return map;
})();

export function industryForCompany(company: string): string {
  const key = (company ?? '').trim().toLowerCase();
  return COMPANY_LOOKUP.get(key) ?? FALLBACK_INDUSTRY;
}

export interface IndustryStats {
  name: string;
  /** Companies in the sweep tagged with this industry. */
  rosterCount: number;
  /** Jobs on the board in this industry. */
  jobCount: number;
  /** Distinct board companies in this industry. */
  boardCompanyCount: number;
  /** Mean match score across scored jobs (score > 0); null when none scored. */
  avgMatch: number | null;
  /** Highest match score in the industry; null when none scored. */
  bestMatch: number | null;
  /** Stage name -> count, only stages with at least one job, pipeline order. */
  stageBreakdown: { stageName: string; count: number }[];
  /** Up to 3 example companies: board companies first, then roster names. */
  exampleCompanies: string[];
}

/** One stats row per roster industry (plus "Other" when unmapped jobs
 * exist), biggest board presence first, then largest roster. */
export function industryStats(jobs: Job[], stages: Stage[]): IndustryStats[] {
  const byIndustry = new Map<string, Job[]>();
  for (const job of jobs) {
    const name = industryForCompany(job.company);
    const list = byIndustry.get(name);
    if (list) list.push(job);
    else byIndustry.set(name, [job]);
  }

  const names = new Set<string>([...Object.keys(SWEEP_ROSTER), ...byIndustry.keys()]);
  const stats: IndustryStats[] = [];
  for (const name of names) {
    const list = byIndustry.get(name) ?? [];
    const companies = new Map<string, number>();
    for (const j of list) companies.set(j.company, (companies.get(j.company) ?? 0) + 1);
    const scored = list.filter((j) => j.matchScore > 0);
    const boardFirst = [...companies.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([company]) => company);
    const rosterNames = (SWEEP_ROSTER[name] ?? []).filter((c) => !companies.has(c));
    stats.push({
      name,
      rosterCount: (SWEEP_ROSTER[name] ?? []).length,
      jobCount: list.length,
      boardCompanyCount: companies.size,
      avgMatch:
        scored.length === 0
          ? null
          : Math.round(scored.reduce((sum, j) => sum + j.matchScore, 0) / scored.length),
      bestMatch: scored.length === 0 ? null : Math.max(...scored.map((j) => j.matchScore)),
      stageBreakdown: stages
        .map((s) => ({ stageName: s.name, count: list.filter((j) => j.stageId === s.id).length }))
        .filter((s) => s.count > 0),
      exampleCompanies: [...boardFirst, ...rosterNames].slice(0, 3),
    });
  }

  return stats.sort(
    (a, b) => b.jobCount - a.jobCount || b.rosterCount - a.rosterCount || a.name.localeCompare(b.name),
  );
}
